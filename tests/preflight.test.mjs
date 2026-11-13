import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { accountFallbackLockPath, accountTestLockPath, bundleSources, engineProblems, objectKeys, runPreflight, safeLine } from '../scripts/preflight.mjs'

const script = fileURLToPath(new URL('../scripts/preflight.mjs', import.meta.url))
const syntheticIdentity = ticks => `linux:00000000-0000-4000-8000-000000000001:${ticks}:time:[1]:pid:[2]`
const currentRegister = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const tableFiles = [['hooks/i18n.ts', 'ZH_TW'], ['hooks/strings-en.ts', 'EN'], ['hooks/strings-zh-cn.ts', 'ZH_CN']]
const homeNames = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROGRESS_FILE']
const realTables = tableFiles.map(([path, name]) => ({ path, name, text: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }))
// Handover recovery must see only this suite's disposable temporary folders.
const suiteTemp = mkdtempSync(join(tmpdir(), 'preflight-suite-'))
const tempNames = ['TMPDIR', 'TMP', 'TEMP']
const originalTemps = new Map(tempNames.map(name => [name, process.env[name]]))
for (const name of tempNames) process.env[name] = suiteTemp
const templateRoot = mkdtempSync(join(tmpdir(), 'preflight-template-'))
const templateRepo = join(templateRoot, 'repo')
after(() => rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
after(() => {
  for (const [name, value] of originalTemps) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(suiteTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

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
  // Module-only injection keeps CLI fixtures off the real account lock, even inside preflight.
  const cli = join(root, 'preflight-cli.mjs')
  writeFileSync(cli, `import { main } from ${JSON.stringify(pathToFileURL(script).href)}\nprocess.exitCode = await main(process.argv.slice(2), { lockPath: ${JSON.stringify(lockPath)}, fallbackLockPath: null })\n`)
  const check = options => runPreflight({ cwd, isNoFetch: true, run, lockPath, fallbackLockPath: null, readProcessIdentity: syntheticIdentity, lockPlatform: 'linux', ...options })
  return { root, cwd, home, env, lockPath, cli, write, git, commit, check, run }
}

const has = (checks, state, text) => checks.some(item => item.state === state && item.message.includes(text))

const mainFixture = (t, { isSame = false, hasImportFailure = false, mainSource } = {}) => {
  const f = fixture(t)
  const local = readFileSync(script, 'utf8')
  for (const name of ['pr-check.mjs', 'changelog-fold.mjs', 'bundle-text.mjs', 'preflight-lock-policy.mjs']) {
    f.write(`scripts/${name}`, readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8'))
  }
  const main = mainSource ?? (isSame ? local : `import { message } from './main-only-message.mjs'\n${local.replace("'the branch contains the base.'", 'message')}`)
  f.write('scripts/preflight.mjs', `${hasImportFailure ? "throw new Error('synthetic private import details')\n" : ''}${main}`)
  f.write('scripts/main-only-message.mjs', "export const message = 'the branch contains the base (checked by main).'\n")
  f.commit()
  const sha = f.git('rev-parse', 'HEAD')
  f.git('branch', 'main')
  f.git('update-ref', 'refs/remotes/origin/main', sha)
  f.git('remote', 'add', 'origin', f.cwd)
  f.write('scripts/preflight.mjs', local)
  rmSync(join(f.cwd, 'scripts/main-only-message.mjs'))
  f.commit()
  return { ...f, sha }
}

const startUnrelatedProcess = async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  return child
}

const stopUnrelatedProcess = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

test('preflight warns once and uses the local copy when fetching is disabled', async t => {
  const f = fixture(t)
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'contains the base'))
  assert.equal(checks.filter(item => item.state === 'FAIL').length, 0)
  assert.deepEqual(checks.filter(item => item.state === 'WARN').map(item => item.message), [
    'using the local preflight because --no-fetch was supplied; origin/main freshness is unknown.',
  ])
})

test('preflight warns that a release branch behind main needs current main, with the PR title given', async t => {
  const f = fixture(t)
  const tree = f.git('rev-parse', 'HEAD^{tree}')
  f.git('update-ref', 'refs/remotes/origin/main', f.git('commit-tree', tree, '-p', 'HEAD', '-m', 'New main'))
  f.write('body.md', 'Synthetic body\n')
  const checks = await f.check({ bodyFile: 'body.md', title: 'chore(release): Agent Board 9.9.9' })
  assert.ok(has(checks, 'WARN', 'release pull request needs current main'))
  assert.equal(has(checks, 'WARN', 'does not contain the latest main'), false)
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

test('preflight fetches main by default and warns once while keeping the local copy when fetch fails', async t => {
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
  assert.equal(checks.some(item => item.state === 'FAIL'), false)
  assert.equal(has(checks, 'PASS', 'contains the base'), false)
  assert.deepEqual(checks.filter(item => item.state === 'WARN').map(item => item.message), [
    'using the local preflight because git fetch origin main failed; origin/main freshness is unknown.',
  ])
  assert.deepEqual(calls, [['fetch', 'origin', 'main']])
  calls.length = 0
  await f.check({ run })
  assert.equal(calls.length, 0)
})

test('an older preflight runs main once in a detached temporary checkout against the branch with one test lock', async t => {
  const f = mainFixture(t)
  const signalListeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]))
  f.write('branch-only.txt', 'the working checkout')
  f.write('branch-body.md', 'a body from the working checkout')
  f.write('tests/branch-only.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\ntest('the working checkout is checked', () => assert.equal(readFileSync('branch-only.txt', 'utf8'), 'the working checkout'))\n")
  const before = f.git('worktree', 'list', '--porcelain')
  const events = []
  const checkouts = []
  const bodies = []
  let fetches = 0
  let tests = 0
  let locks = 0
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'fetch') fetches++
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      assert.equal(args[2], '--detach')
      const checkout = args[3]
      checkouts.push(checkout)
      assert.equal(dirname(dirname(checkout)), tmpdir())
      const result = f.run(program, args, options)
      assert.equal(result.status, 0, result.stderr)
      const detached = f.run('git', ['symbolic-ref', '-q', 'HEAD'], { ...options, cwd: checkout })
      assert.equal(detached.status, 1)
      assert.equal(f.run('git', ['rev-parse', 'HEAD'], { ...options, cwd: checkout }).stdout.trim(), f.sha)
      return result
    }
    if (args.includes('--test')) {
      tests++
      assert.equal(options.cwd, f.cwd)
    }
    if (args[0] === 'scripts/pr-check.mjs') {
      bodies.push({ args, cwd: options.cwd })
      return { status: 0, stdout: '', stderr: '' }
    }
    return f.run(program, args, options)
  }
  const checks = await f.check({
    isNoFetch: false, base: 'HEAD', bodyFile: 'branch-body.md', title: 'fix: synthetic handoff', run,
    onCheck: item => events.push(item),
    onLockPublished: () => {
      locks++
      const markers = readdirSync(f.lockPath).filter(name => name.endsWith('.lock'))
      assert.equal(markers.length, 1)
      assert.equal(JSON.parse(readFileSync(join(f.lockPath, `${markers[0]}.start`), 'utf8')), syntheticIdentity(process.pid))
    },
  })
  assert.ok(has(checks, 'PASS', 'checked by main'))
  assert.deepEqual(checks.filter(item => item.message.startsWith('preflight from origin/main ')), [
    { state: 'PASS', message: `preflight from origin/main ${f.sha}` },
  ])
  assert.ok(has(checks, 'PASS', 'tests/branch-only.test.mjs: 1 tests, 0 failed'))
  assert.equal(checks.some(item => item.state !== 'PASS'), false, JSON.stringify(checks))
  assert.deepEqual(events, checks)
  assert.equal(fetches, 1)
  assert.equal(tests, 1)
  assert.equal(locks, 1)
  assert.equal(checkouts.length, 1)
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0], {
    args: ['scripts/pr-check.mjs', '--body-file', join(f.cwd, 'branch-body.md'), '--title', 'fix: synthetic handoff', '--no-bundle', '--base', 'HEAD'],
    cwd: f.cwd,
  })
  assert.equal(existsSync(dirname(checkouts[0])), false)
  assert.deepEqual(readdirSync(f.lockPath), [])
  assert.equal(f.git('worktree', 'list', '--porcelain'), before)
  for (const [signal, listeners] of signalListeners) assert.deepEqual(process.listeners(signal), listeners)
})

test('preflight hands over to a legacy main without fetching a second time', async t => {
  const mainSource = `export const runPreflight = async ({ cwd, isNoFetch, run }) => {
  if (!isNoFetch) {
    const fetched = run('git', ['fetch', 'origin', 'main'], { cwd, encoding: 'utf8' })
    if (fetched.error || fetched.status !== 0) return [{ state: 'FAIL', message: 'legacy main fetch failed' }]
  }
  return [{ state: 'PASS', message: 'legacy main ran' }]
}\n`
  const f = mainFixture(t, { mainSource })
  let fetches = 0
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'fetch' && ++fetches === 2) return { status: 1, stdout: '', stderr: 'synthetic second fetch failure' }
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run })
  assert.equal(fetches, 1)
  assert.ok(has(checks, 'PASS', 'legacy main ran'))
  assert.equal(checks.some(item => item.state !== 'PASS'), false, JSON.stringify(checks))
})

test('preflight removes dead owners\' worktrees and folders while keeping live owners and other paths', async t => {
  const f = mainFixture(t)
  const dead = await startUnrelatedProcess()
  const deadPid = dead.pid
  await stopUnrelatedProcess(dead)
  const live = await startUnrelatedProcess()
  const orphan = mkdtempSync(join(tmpdir(), `agent-board-preflight-main-${deadPid}-`))
  const folderOnly = mkdtempSync(join(tmpdir(), `agent-board-preflight-main-${deadPid}-`))
  const liveFolder = mkdtempSync(join(tmpdir(), `agent-board-preflight-main-${live.pid}-`))
  const other = mkdtempSync(join(tmpdir(), `unrelated-preflight-main-${deadPid}-`))
  const orphanCheckout = join(orphan, 'repo')
  const liveCheckout = join(liveFolder, 'repo')
  try {
    f.git('worktree', 'add', '--detach', orphanCheckout, f.sha)
    f.git('worktree', 'add', '--detach', liveCheckout, f.sha)
    // Git lists the long path, while a Windows runner's TEMP can be an 8.3 short path (RUNNER~1).
    const listed = path => realpathSync.native(path).replaceAll('\\', '/').toLowerCase()
    const orphanListed = listed(orphanCheckout)
    const liveListed = listed(liveCheckout)
    writeFileSync(join(folderOnly, 'marker'), 'orphan')
    writeFileSync(join(other, 'marker'), 'keep')
    const checks = await f.check({ isNoFetch: false })
    const listing = f.git('worktree', 'list', '--porcelain').replaceAll('\\', '/').toLowerCase()
    assert.ok(listing.includes(liveListed), listing)
    assert.equal(existsSync(orphan), false)
    assert.equal(existsSync(folderOnly), false)
    assert.equal(listing.includes(orphanListed), false)
    assert.equal(existsSync(liveCheckout), true)
    assert.equal(readFileSync(join(other, 'marker'), 'utf8'), 'keep')
    assert.equal(checks.some(item => item.state === 'FAIL'), false, JSON.stringify(checks))
  } finally {
    for (const checkout of [orphanCheckout, liveCheckout]) f.run('git', ['worktree', 'remove', '--force', checkout], { cwd: f.cwd })
    await stopUnrelatedProcess(live)
    for (const folder of [orphan, folderOnly, liveFolder, other]) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('preflight leaves another account\'s private orphan folders untouched and completes its handover', async t => {
  const f = mainFixture(t)
  const dead = await startUnrelatedProcess()
  const deadPid = dead.pid
  await stopUnrelatedProcess(dead)
  const registered = mkdtempSync(join(tmpdir(), `agent-board-preflight-main-${deadPid}-`))
  const unregistered = mkdtempSync(join(tmpdir(), `agent-board-preflight-main-${deadPid}-`))
  const checkout = join(registered, 'repo')
  f.git('worktree', 'add', '--detach', checkout, f.sha)
  for (const folder of [registered, unregistered]) {
    chmodSync(folder, 0o700)
    writeFileSync(join(folder, 'marker'), 'another account')
  }
  const keyOf = path => {
    const key = resolve(path).replaceAll('\\', '/')
    return process.platform === 'win32' ? key.toLowerCase() : key
  }
  const foreign = new Set([registered, unregistered].flatMap(path => [keyOf(path), keyOf(realpathSync.native(path))]))
  const foreignCheckouts = new Set([keyOf(checkout), keyOf(realpathSync.native(checkout))])
  const listedCheckout = realpathSync.native(checkout).replaceAll('\\', '/').toLowerCase()
  const removed = []
  const readStat = fs.lstatSync
  const remove = fs.rmSync
  const account = os.userInfo()
  const uid = account.uid === -1 ? 1001 : account.uid
  // Synthetic metadata exercises Unix ownership on every runner without another account or elevated access.
  const accountMock = t.mock.method(os, 'userInfo', () => ({ ...account, uid }))
  const statMock = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const stat = readStat(path, ...args)
    return foreign.has(keyOf(path)) ? Object.assign(Object.create(stat), { uid: uid + 1 }) : stat
  })
  const removeMock = t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (foreign.has(keyOf(path))) {
      removed.push(keyOf(path))
      throw Object.assign(new Error('synthetic foreign account permissions'), { code: 'EACCES' })
    }
    return remove(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    const checks = await f.check({
      isNoFetch: false,
      run: (program, args, options) => {
        if (program === 'git' && args[0] === 'worktree' && args[1] === 'remove' && foreignCheckouts.has(keyOf(args.at(-1)))) {
          removed.push(keyOf(checkout))
          return { status: 1, stdout: '', stderr: 'synthetic foreign account permissions' }
        }
        return f.run(program, args, options)
      },
    })
    assert.deepEqual(removed, [])
    assert.ok(has(checks, 'PASS', `preflight from origin/main ${f.sha}`), JSON.stringify(checks))
    assert.equal(checks.some(item => item.state === 'FAIL'), false, JSON.stringify(checks))
    for (const folder of [registered, unregistered]) assert.equal(readFileSync(join(folder, 'marker'), 'utf8'), 'another account')
    assert.ok(f.git('worktree', 'list', '--porcelain').replaceAll('\\', '/').toLowerCase().includes(listedCheckout))
  } finally {
    for (const mock of [accountMock, statMock, removeMock]) mock.mock.restore()
    syncBuiltinESMExports()
    f.run('git', ['worktree', 'remove', '--force', checkout], { cwd: f.cwd })
    for (const folder of [registered, unregistered]) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('preflight prunes a registration after its checkout removal fails', async t => {
  const f = mainFixture(t)
  const before = f.git('worktree', 'list', '--porcelain')
  const checkouts = []
  let folderAtPrune
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') checkouts.push(args[3])
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'remove') return { status: 1, stdout: '', stderr: 'synthetic remove failure' }
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'prune') folderAtPrune = existsSync(dirname(checkouts[0]))
    return f.run(program, args, options)
  }
  try {
    const checks = await f.check({ isNoFetch: false, run })
    assert.ok(has(checks, 'FAIL', 'preflight from origin/main could not finish'))
    assert.equal(checkouts.length, 1)
    assert.equal(existsSync(dirname(checkouts[0])), false)
    assert.equal(folderAtPrune, false)
    assert.equal(f.git('worktree', 'list', '--porcelain'), before)
  } finally {
    for (const checkout of checkouts) f.run('git', ['worktree', 'remove', '--force', checkout], { cwd: f.cwd })
    f.git('worktree', 'prune')
  }
})

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`preflight cleans up its checkout on ${signal} during handover`, t => {
    const mainSource = `import { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { fileURLToPath } from 'node:url'\nexport const runPreflight = async ({ cwd }) => {\n  writeFileSync(join(cwd, 'signal-ready.json'), JSON.stringify({ script: fileURLToPath(import.meta.url) }))\n  if (process.platform === 'win32') process.emit(${JSON.stringify(signal)})\n  else {\n    process.kill(process.pid, ${JSON.stringify(signal)})\n    await new Promise(() => setInterval(() => {}, 1000))\n  }\n  return []\n}\n`
    const f = mainFixture(t, { mainSource })
    const before = f.git('worktree', 'list', '--porcelain')
    const launcher = join(f.root, 'signal-launcher.mjs')
    writeFileSync(launcher, `import { runPreflight } from ${JSON.stringify(pathToFileURL(script).href)}\nawait runPreflight({ cwd: ${JSON.stringify(f.cwd)}, lockPath: ${JSON.stringify(f.lockPath)}, fallbackLockPath: null })\n`)
    const result = spawnSync(process.execPath, [launcher], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.error, undefined)
    assert.ok(existsSync(join(f.cwd, 'signal-ready.json')), result.stdout + result.stderr)
    assert.equal(result.status, exitCode, result.stdout + result.stderr)
    const { script: mainScript } = JSON.parse(readFileSync(join(f.cwd, 'signal-ready.json'), 'utf8'))
    const temp = dirname(dirname(dirname(mainScript)))
    assert.match(temp, new RegExp(`agent-board-preflight-main-\\d+-[^\\\\/]+$`))
    assert.equal(existsSync(temp), false)
    assert.equal(f.git('worktree', 'list', '--porcelain'), before)
  })
}

test('preflight carries the synthetic lock platform and namespace guard through the main handover', async t => {
  const f = mainFixture(t)
  f.write('tests/handover-namespace.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const name = '2147483647-00000000-0000-4000-8000-000000000041.lock'
  const marker = join(f.lockPath, name)
  const recorded = syntheticIdentity(1).replace('pid:[2]', 'pid:[3]')
  writeFileSync(`${marker}.start`, JSON.stringify(recorded))
  writeFileSync(marker, '')
  const before = f.git('worktree', 'list', '--porcelain')
  let testStarts = 0
  const checks = await f.check({
    isNoFetch: false,
    lockPlatform: 'linux',
    run: (program, args, options) => {
      if (args.includes('--test')) {
        testStarts++
        return { status: 0, stdout: '# tests 1\n# fail 0\n', stderr: '' }
      }
      return f.run(program, args, options)
    },
  })
  assert.ok(has(checks, 'PASS', `preflight from origin/main ${f.sha}`))
  assert.ok(has(checks, 'FAIL', 'time or process ID namespace'))
  assert.equal(testStarts, 0)
  assert.equal(readFileSync(marker, 'utf8'), '')
  assert.equal(readFileSync(`${marker}.start`, 'utf8'), JSON.stringify(recorded))
  assert.deepEqual(readdirSync(f.lockPath).sort(), [name, `${name}.start`].sort())
  assert.equal(f.git('worktree', 'list', '--porcelain'), before)
})

test('preflight keeps an identical local checker after fetching without creating a temporary checkout', async t => {
  const f = mainFixture(t, { isSame: true })
  let fetches = 0
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'fetch') fetches++
    assert.ok(!(program === 'git' && args[0] === 'worktree'))
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run })
  assert.equal(fetches, 1)
  assert.equal(checks.some(item => item.message.startsWith('preflight from origin/main ')), false)
  assert.equal(checks.some(item => item.state !== 'PASS'), false)
})

test('preflight does not hand over to a different main checker when fetching is disabled', async t => {
  const f = mainFixture(t)
  const run = (program, args, options) => {
    assert.ok(!(program === 'git' && ['fetch', 'worktree'].includes(args[0])))
    return f.run(program, args, options)
  }
  const checks = await f.check({ run })
  assert.equal(checks.filter(item => item.state === 'WARN').length, 1)
  assert.ok(has(checks, 'WARN', 'using the local preflight because --no-fetch'))
  assert.ok(has(checks, 'PASS', 'contains the base'))
  assert.equal(checks.some(item => item.message.includes('checked by main')), false)
  assert.equal(checks.some(item => item.message.startsWith('preflight from origin/main ')), false)
})

test('preflight returns main checker failures and removes its temporary checkout and test lock', async t => {
  const f = mainFixture(t)
  f.write('tests/branch-failure.test.mjs', "import test from 'node:test'\ntest('a synthetic branch failure', () => { throw new Error('expected fixture failure') })\n")
  const before = f.git('worktree', 'list', '--porcelain')
  const checkouts = []
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') checkouts.push(args[3])
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run })
  assert.ok(has(checks, 'PASS', `preflight from origin/main ${f.sha}`))
  assert.ok(has(checks, 'FAIL', 'tests/branch-failure.test.mjs: 1 tests, 1 failed; failed: a synthetic branch failure'))
  assert.equal(checkouts.length, 1)
  assert.equal(existsSync(dirname(checkouts[0])), false)
  assert.deepEqual(readdirSync(f.lockPath), [])
  assert.equal(f.git('worktree', 'list', '--porcelain'), before)
})

test('preflight removes the detached checkout when main cannot load and reports a safe failure', async t => {
  const f = mainFixture(t, { hasImportFailure: true })
  const before = f.git('worktree', 'list', '--porcelain')
  const checkouts = []
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') checkouts.push(args[3])
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run, onLockPublished: () => assert.fail('tests must not start') })
  assert.ok(has(checks, 'FAIL', 'preflight from origin/main could not finish'))
  assert.doesNotMatch(JSON.stringify(checks), /synthetic private import details/)
  assert.equal(checkouts.length, 1)
  assert.equal(existsSync(dirname(checkouts[0])), false)
  assert.equal(existsSync(f.lockPath), false)
  assert.equal(f.git('worktree', 'list', '--porcelain'), before)
})

test('preflight removes the temporary folder when the detached checkout cannot be created', async t => {
  const f = mainFixture(t)
  const before = f.git('worktree', 'list', '--porcelain')
  const checkouts = []
  const run = (program, args, options) => {
    if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      checkouts.push(args[3])
      return { status: 1, stdout: '', stderr: 'synthetic private checkout details' }
    }
    return f.run(program, args, options)
  }
  const checks = await f.check({ isNoFetch: false, run, onLockPublished: () => assert.fail('tests must not start') })
  assert.ok(has(checks, 'FAIL', 'preflight from origin/main could not finish'))
  assert.doesNotMatch(JSON.stringify(checks), /synthetic private checkout details/)
  assert.equal(checkouts.length, 1)
  assert.equal(existsSync(dirname(checkouts[0])), false)
  assert.equal(existsSync(f.lockPath), false)
  assert.equal(f.git('worktree', 'list', '--porcelain'), before)
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
  const result = spawnSync(process.execPath, [f.cli, '--no-fetch'], { cwd: f.cwd, env: childEnv, encoding: 'utf8', timeout: 15000 })
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
  mkdirSync(f.lockPath, { mode: 0o700 })
  writeFileSync(join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000001.lock`), '')
  let hasStarted = false
  const run = (program, args, options) => {
    if (args.includes('--test')) hasStarted = true
    return f.run(program, args, options)
  }
  const checks = await f.check({ run })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
  assert.match(failure.message, new RegExp(`process ${process.pid}\\b`))
  assert.match(failure.message, /started \d+ minutes? ago/)
  assert.match(failure.message, /delete its \.lock file/)
  assert.equal(failure.message.includes(f.root), false)
  assert.equal(hasStarted, false)
})

test('preflight fails when the messaging matrix is stale', async t => {
  const f = fixture(t)
  f.write('scripts/messaging-matrix.mjs', "console.error('Messaging matrix is stale: README.md.'); process.exitCode = 1\n")
  assert.ok(has(await f.check(), 'FAIL', 'messaging matrix: Messaging matrix is stale: README.md.'))
  f.write('scripts/messaging-matrix.mjs', "if (process.argv[2] === '--check') console.log('ok')\n")
  assert.ok(has(await f.check(), 'PASS', 'messaging matrix is up to date.'))
})

test('preflight recovers a stale test lock and releases its own lock after a failed run', async t => {
  const f = fixture(t)
  f.write('tests/stale.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const stale = join(f.lockPath, '2147483647-00000000-0000-4000-8000-000000000001.lock')
  writeFileSync(`${stale}.start`, JSON.stringify(syntheticIdentity(1)))
  writeFileSync(stale, '')
  const run = (program, args, options) => args.includes('--test')
    ? { status: 1, stdout: '# tests 1\n# fail 1\n', stderr: '' }
    : f.run(program, args, options)
  assert.ok(has(await f.check({ run }), 'FAIL', 'tests/stale.test.mjs: 1 tests, 1 failed'))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('a legacy preflight marker is live while its process is alive', async () => {
  const { isLiveMarker } = await import('../scripts/preflight.mjs')
  const marker = { isAlive: true }
  assert.equal(isLiveMarker(marker), true)
  assert.equal(isLiveMarker({ ...marker, isAlive: false }), false)
})

test('recorded preflight identities use equality and keep unreadable live owners', async () => {
  const { isLiveMarker } = await import('../scripts/preflight.mjs')
  const original = 'linux:00000000-0000-4000-8000-000000000001:12345'
  const marker = { isAlive: true, recordedIdentity: original, identity: original }
  assert.equal(isLiveMarker(marker), true)
  assert.equal(isLiveMarker({ ...marker, identity: original.replace('12345', '12346') }), false)
  assert.equal(isLiveMarker({ ...marker, identity: original.replace('000000000001', '000000000002') }), false)
  assert.equal(isLiveMarker({ ...marker, identity: null }), true)
  assert.equal(isLiveMarker({ ...marker, recordedIdentity: null }), true)
  assert.equal(isLiveMarker({ ...marker, isAlive: false }), false)
})

test('preflight parses synthetic Linux process ticks and boot time', async () => {
  const { parseProcStat, parseBootTime } = await import('../scripts/preflight.mjs')
  const stat = `42 (a ) ( process name) ${['S', ...Array(18).fill('0'), '12345', '0'].join(' ')}`
  assert.equal(parseProcStat(stat), 12345)
  assert.equal(parseBootTime('cpu 1 2 3\nbtime 1700000000\nprocesses 9\n'), 1_700_000_000_000)
  for (const bad of ['', '42 no parentheses S 1', '42 (worker) S 1', stat.replace('12345', 'bad')]) assert.equal(parseProcStat(bad), null)
  for (const bad of ['', 'btime x', 'notbtime 123', 'btime 123 extra']) assert.equal(parseBootTime(bad), null)
})

test('preflight parses synthetic ps start times and rejects malformed dates', async () => {
  const { parsePsLstart } = await import('../scripts/preflight.mjs')
  assert.equal(parsePsLstart('Mon Nov  4 05:06:07 2024\n'), Date.UTC(2024, 10, 4, 5, 6, 7))
  for (const bad of ['', 'not a date', 'Mon Xxx 4 05:06:07 2024', 'Mon Feb 30 05:06:07 2024', 'Mon Nov 4 25:06:07 2024']) assert.equal(parsePsLstart(bad), null)
})

test('preflight reads process starts through the platform-specific sources', async () => {
  const { processStartedMs } = await import('../scripts/preflight.mjs')
  const stat = `42 (worker ) ( name) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
  const paths = []
  const readText = path => {
    paths.push(path)
    return path === '/proc/42/stat' ? stat : 'btime 1700000000\n'
  }
  assert.equal(processStartedMs(42, { platform: 'linux', readText, clockTicks: () => 100 }), 1_700_000_123_450)
  assert.deepEqual(paths, ['/proc/42/stat', '/proc/stat'])
  assert.equal(processStartedMs(42, { platform: 'linux', readText, clockTicks: () => null }), null)
  const invocations = []
  const run = (program, args, options) => {
    invocations.push({ program, args, options })
    return { status: 0, stdout: program === 'ps' ? 'Mon Nov  4 05:06:07 2024\n' : '2024-11-04T05:06:07.1234567Z\n' }
  }
  assert.equal(processStartedMs(42, { platform: 'darwin', run }), Date.UTC(2024, 10, 4, 5, 6, 7))
  assert.deepEqual(invocations[0].args, ['-o', 'lstart=', '-p', '42'])
  assert.equal(invocations[0].options.env.LC_ALL, 'C')
  assert.equal(invocations[0].options.env.TZ, 'UTC')
  assert.ok(invocations[0].options.timeout > 0)
  const env = { SystemRoot: 'C:\\Windows' }
  assert.equal(processStartedMs(42, { platform: 'win32', run, env }), Date.parse('2024-11-04T05:06:07.123Z'))
  assert.equal(invocations[1].program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.ok(invocations[1].args.includes('-NonInteractive'))
  assert.ok(invocations[1].options.timeout > 0)
  for (const { options } of invocations) assert.equal(options.killSignal, 'SIGKILL')
  assert.equal(processStartedMs(-1, { platform: 'win32', run: () => assert.fail('invalid PID reached PowerShell') }), null)
  for (const platform of ['darwin', 'win32']) {
    assert.equal(processStartedMs(42, { platform, run: () => ({ status: 1, stdout: '' }) }), null)
    assert.equal(processStartedMs(42, { platform, run: () => { throw new Error('unavailable') } }), null)
  }
})

test('preflight only reads Windows process starts with an absolute system PowerShell path', async () => {
  const { processStartedMs } = await import('../scripts/preflight.mjs')
  const calls = []
  const run = (program, args, options) => {
    calls.push({ program, args, options })
    return { status: 0, stdout: '2024-11-04T05:06:07.1234567Z\n' }
  }
  assert.equal(processStartedMs(42, { platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, run }), Date.parse('2024-11-04T05:06:07.123Z'))
  assert.equal(calls[0].program, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  for (const SystemRoot of [undefined, '', 'Windows', 'C:Windows', '\\Windows', '/Windows']) {
    assert.equal(processStartedMs(42, { platform: 'win32', env: { SystemRoot }, run }), null)
  }
  assert.equal(calls.length, 1)
})

test('preflight reads ps starts in UTC through the repeated daylight-saving hour', async t => {
  const { processStartedMs } = await import('../scripts/preflight.mjs')
  const original = process.env.TZ
  process.env.TZ = 'America/New_York'
  t.after(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
  let calls = 0
  const run = (program, args, options) => {
    calls++
    assert.equal(program, 'ps')
    assert.equal(options.env.LC_ALL, 'C')
    assert.equal(options.env.TZ, 'UTC')
    return { status: 0, stdout: 'Sun Nov  3 06:30:00 2024\n' }
  }
  assert.equal(processStartedMs(42, { platform: 'darwin', run }), Date.UTC(2024, 10, 3, 6, 30))
  assert.equal(calls, 1)
})

test('preflight reads stable process identities without Linux wall-clock data', async () => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const boot = '00000000-0000-4000-8000-000000000001'
  const stat = `42 (worker) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
  const paths = []
  const readText = path => {
    paths.push(path)
    if (path === '/proc/42/stat' || path === '/proc/self/stat') return stat
    if (path === '/proc/self/status') return `Name:\tnode\nNSpid:\t${process.pid}\n`
    assert.equal(path, '/proc/sys/kernel/random/boot_id')
    return `${boot}\n`
  }
  const options = { platform: 'linux', readText, readLink: path => path.endsWith('/time') ? 'time:[4026531834]' : 'pid:[4026531836]', run: () => assert.fail('a stable Linux identity needs no subprocess') }
  assert.equal(processStartIdentity(42, options), `linux:${boot}:12345:time:[4026531834]:pid:[4026531836]`)
  assert.deepEqual(paths, ['/proc/42/stat', '/proc/sys/kernel/random/boot_id', '/proc/self/status'])
  paths.length = 0
  assert.equal(processStartIdentity(process.pid, options), `linux:${boot}:12345:time:[4026531834]:pid:[4026531836]`)
  assert.deepEqual(paths, ['/proc/self/stat', '/proc/sys/kernel/random/boot_id', '/proc/self/status'])
  assert.equal(processStartIdentity(42, { ...options, readText: () => 'unreadable' }), null)
  assert.equal(processStartIdentity(42, { ...options, readText: () => { throw new Error('unavailable') } }), null)
  assert.equal(processStartIdentity(-1, options), null)
  assert.equal(processStartIdentity(42, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: () => ({ status: 0, stdout: '2024-11-04T05:06:07.1234567Z\n' }) }), '2024-11-04T05:06:07.1234567Z')
  assert.equal(processStartIdentity(42, { platform: 'darwin', run: () => ({ status: 0, stdout: 'Mon Nov  4 05:06:07 2024\n' }) }), 'darwin-second:2024-11-04T05:06:07.000Z')
})

test('preflight process readers enforce hard deadlines and reject unsuccessful results', async () => {
  const { processStartedMs, processStartIdentity } = await import('../scripts/preflight.mjs')
  const timedOut = { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL', status: null }
  const linuxStat = `42 (worker) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
  for (const platform of ['linux', 'win32', 'darwin']) {
    const calls = []
    const options = {
      platform,
      env: { SystemRoot: 'C:\\Windows' },
      readText: path => path === '/proc/42/stat' ? linuxStat : 'btime 1700000000\n',
      run: (program, args, options) => { calls.push({ program, args, options }); return timedOut },
    }
    assert.equal(processStartedMs(42, options), null)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.killSignal, 'SIGKILL')
    assert.ok(calls[0].options.timeout > 0)
    if (platform === 'linux') assert.equal(calls[0].program, 'getconf')
    else assert.equal(processStartIdentity(42, options), null)
    for (const failure of [{ error: timedOut.error, status: 0 }, { signal: 'SIGKILL', status: 0 }, { status: 1 }]) {
      const stdout = platform === 'linux' ? '100' : platform === 'win32' ? '2024-11-04T05:06:07.123Z' : 'Mon Nov  4 05:06:07 2024'
      assert.equal(processStartedMs(42, { ...options, run: () => ({ ...failure, stdout }) }), null)
    }
  }
})

test('preflight publishes its identity beside an empty marker that legacy readers recognize', async t => {
  const f = fixture(t)
  f.write('tests/published-identity.test.mjs', '')
  let hasPublished = false
  const checks = await f.check({
    onLockPublished: () => {
      const names = readdirSync(f.lockPath)
      const name = names.find(name => name.endsWith('.lock'))
      assert.match(name, new RegExp(`^${process.pid}-[0-9a-f-]+\\.lock$`))
      const marker = join(f.lockPath, name)
      assert.equal(lstatSync(marker).size, 0)
      assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), syntheticIdentity(process.pid))
      assert.deepEqual(names.sort(), [name, `${name}.start`].sort())
      hasPublished = true
    },
  })
  assert.equal(hasPublished, true)
  assert.ok(has(checks, 'PASS', 'tests/published-identity.test.mjs: 1 tests, 0 failed'))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight publishes a null identity when its own identity is unreadable', async t => {
  const f = fixture(t)
  f.write('tests/unpublished-identity.test.mjs', '')
  let recorded
  const checks = await f.check({
    readProcessIdentity: () => null,
    onLockPublished: () => {
      const name = readdirSync(f.lockPath).find(name => name.endsWith('.lock'))
      recorded = JSON.parse(readFileSync(join(f.lockPath, `${name}.start`), 'utf8'))
    },
  })
  assert.equal(recorded, null)
  assert.ok(has(checks, 'PASS', 'tests/unpublished-identity.test.mjs: 1 tests, 0 failed'))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

for (const isWatched of [false, true]) {
  const folder = isWatched ? 'watched' : 'own'

  // A legacy marker blocks whatever the clock says.
  test(`preflight keeps a legacy marker without a recorded identity in its ${folder} folder`, async t => {
    const f = fixture(t)
    f.write('tests/legacy-clock-step.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const name = `${process.pid}-00000000-0000-4000-8000-000000000031.lock`
    const marker = join(directory, name)
    writeFileSync(marker, '')
    let runs = 0
    const checks = await f.check({
      fallbackLockPath: isWatched ? directory : null,
      onProgress: () => { runs++ },
    })
    const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
    assert.ok(failure)
    assert.match(failure.message, /owner could not be confirmed/)
    assert.match(failure.message, /if no preflight is running/)
    assert.ok(failure.message.includes(name))
    assert.equal(runs, 0)
    assert.equal(existsSync(marker), true)
    assert.equal(existsSync(`${marker}.start`), false)
    if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
  })

  for (const isTagged of [false, true]) {
    // An untagged record is what this pull request's c3247d6 wrote on macOS; it must still count as the same owner.
    test(`preflight warns when a macOS identity has second precision in its ${folder} folder with a ${isTagged ? 'tagged' : 'untagged'} record`, async t => {
      const { processStartIdentity } = await import('../scripts/preflight.mjs')
      const f = fixture(t)
      f.write('tests/mac-precision.test.mjs', '')
      const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
      mkdirSync(directory, { mode: 0o700 })
      const name = `${process.pid}-00000000-0000-4000-8000-000000000032.lock`
      const marker = join(directory, name)
      const start = '2024-11-04T05:06:07.000Z'
      const record = isTagged ? `darwin-second:${start}` : start
      writeFileSync(`${marker}.start`, JSON.stringify(record))
      writeFileSync(marker, '')
      let runs = 0
      const checks = await f.check({
        fallbackLockPath: isWatched ? directory : null,
        lockPlatform: 'darwin',
        readProcessIdentity: () => processStartIdentity(process.pid, { platform: 'darwin', run: () => ({ status: 0, stdout: 'Mon Nov  4 05:06:07 2024\n' }) }),
        onProgress: () => { runs++ },
      })
      const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
      assert.ok(failure)
      assert.match(failure.message, /second/)
      assert.match(failure.message, /reused process ID/)
      assert.match(failure.message, /if no preflight is running/)
      assert.ok(failure.message.includes(name))
      assert.equal(runs, 0)
      assert.equal(existsSync(marker), true)
      assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), record)
      if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
    })
  }

  test(`preflight keeps a matching Linux identity in its ${folder} folder after a forward clock step`, async t => {
    const { processStartedMs, processStartIdentity } = await import('../scripts/preflight.mjs')
    const f = fixture(t)
    f.write('tests/clock-step.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const marker = join(directory, `${process.pid}-00000000-0000-4000-8000-000000000025.lock`)
    let bootSeconds = Math.floor(Date.now() / 1000) - 1000
    const readText = path => path === '/proc/stat' ? `btime ${bootSeconds}\n`
      : path === '/proc/sys/kernel/random/boot_id' ? '00000000-0000-4000-8000-000000000001\n'
        : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n`
          : `42 (worker) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
    const options = { platform: 'linux', readText, readLink: path => path.endsWith('/time') ? 'time:[4026531834]' : 'pid:[4026531836]', clockTicks: () => 100 }
    const identity = processStartIdentity(process.pid, options)
    assert.ok(identity)
    writeFileSync(`${marker}.start`, JSON.stringify(identity))
    writeFileSync(marker, '')
    bootSeconds += 3600
    assert.ok(processStartedMs(process.pid, options) > statSync(marker).mtimeMs + 5000)
    let runs = 0
    const checks = await f.check({
      fallbackLockPath: isWatched ? directory : null,
      readProcessIdentity: pid => processStartIdentity(pid, options),
      onProgress: () => { runs++ },
    })
    const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
    assert.ok(failure)
    assert.doesNotMatch(failure.message, /start time could not be read/)
    assert.equal(runs, 0)
    assert.equal(existsSync(marker), true)
    assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), identity)
    if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
  })

  test(`preflight treats a different identity with the same live PID in its ${folder} folder as reused`, async t => {
    const f = fixture(t)
    f.write('tests/reused-identity.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const marker = join(directory, `${process.pid}-00000000-0000-4000-8000-000000000026.lock`)
    writeFileSync(`${marker}.start`, JSON.stringify('linux:00000000-0000-4000-8000-000000000001:12345:time:[1]:pid:[2]'))
    writeFileSync(marker, '')
    const checks = await f.check({
      fallbackLockPath: isWatched ? directory : null,
      readProcessIdentity: () => 'linux:00000000-0000-4000-8000-000000000001:12346:time:[1]:pid:[2]',
    })
    assert.ok(has(checks, 'PASS', 'tests/reused-identity.test.mjs: 1 tests, 0 failed'))
    assert.equal(existsSync(marker), isWatched)
    assert.equal(existsSync(`${marker}.start`), isWatched)
    assert.deepEqual(readdirSync(f.lockPath), [])
  })

  test(`preflight keeps an identity marker in its ${folder} folder when the current start is unreadable`, async t => {
    const f = fixture(t)
    f.write('tests/unknown-identity.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const marker = join(directory, `${process.pid}-00000000-0000-4000-8000-000000000027.lock`)
    writeFileSync(`${marker}.start`, JSON.stringify('synthetic:original-start'))
    writeFileSync(marker, '')
    let runs = 0
    const checks = await f.check({
      fallbackLockPath: isWatched ? directory : null,
      readProcessIdentity: () => null,
      onProgress: () => { runs++ },
    })
    assert.ok(has(checks, 'FAIL', 'process start time could not be read'))
    assert.equal(runs, 0)
    assert.equal(existsSync(marker), true)
    assert.equal(existsSync(`${marker}.start`), true)
    if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
  })
}

for (const identity of ['linux:00000000-0000-4000-8000-000000000001:12345:time:[1]:pid:[2]', '2024-11-04T05:06:07.1234567Z']) {
  const platform = identity.startsWith('linux:') ? 'Linux' : 'Windows'
  test(`preflight treats exact ${platform} identities as confirmed without a second-precision warning`, async t => {
    const f = fixture(t)
    f.write('tests/exact-identity.test.mjs', '')
    mkdirSync(f.lockPath, { mode: 0o700 })
    const name = `${process.pid}-00000000-0000-4000-8000-000000000033.lock`
    const marker = join(f.lockPath, name)
    writeFileSync(`${marker}.start`, JSON.stringify(identity))
    writeFileSync(marker, '')
    const checks = await f.check({ lockPlatform: platform === 'Linux' ? 'linux' : 'win32', readProcessIdentity: () => identity, onProgress: () => assert.fail('tests must not start') })
    const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
    assert.ok(failure)
    assert.doesNotMatch(failure.message, /reused process ID|known only to the second|owner could not be confirmed/)
    assert.ok(failure.message.includes(name))
    assert.equal(existsSync(marker), true)
  })
}

test('preflight tags a Linux identity with the time and PID namespaces it was read through', async () => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const boot = '00000000-0000-4000-8000-000000000001'
  const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0`
  const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
    : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
  const links = []
  const readLink = path => {
    links.push(path)
    return path.endsWith('/time') ? 'time:[4026531834]' : 'pid:[4026531836]'
  }
  assert.equal(processStartIdentity(42, { platform: 'linux', readText, readLink }), `linux:${boot}:12345:time:[4026531834]:pid:[4026531836]`)
  assert.deepEqual(links, ['/proc/self/ns/time', '/proc/self/ns/pid'])
})

test('preflight retains the time namespace when the PID namespace is unreadable or invalid', async () => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const boot = '00000000-0000-4000-8000-000000000001'
  const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0`
  const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
    : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
  for (const invalid of [false, true]) {
    const readLink = path => {
      if (path.endsWith('/time')) return 'time:[4026531834]'
      if (invalid) return 'pid:[invalid]'
      throw new Error('no PID namespace')
    }
    assert.equal(processStartIdentity(42, { platform: 'linux', readText, readLink }), `linux:${boot}:12345:time:[4026531834]`)
  }
})

test('preflight retains the PID namespace when the time namespace is unreadable or invalid', async () => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const boot = '00000000-0000-4000-8000-000000000001'
  const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0`
  const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
    : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
  for (const invalid of [false, true]) {
    const readLink = path => {
      if (!path.endsWith('/time')) return 'pid:[4026531836]'
      if (invalid) return 'time:[invalid]'
      throw new Error('no time namespace')
    }
    assert.equal(processStartIdentity(42, { platform: 'linux', readText, readLink }), `linux:${boot}:12345:pid:[4026531836]`)
  }
})

test('preflight omits both Linux namespaces when neither can be read', async () => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const boot = '00000000-0000-4000-8000-000000000001'
  const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0`
  const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
    : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
  const readLink = path => { throw new Error(`unreadable ${path}`) }
  assert.equal(processStartIdentity(42, { platform: 'linux', readText, readLink }), `linux:${boot}:12345`)
})

for (const [scenario, status, readerPid] of [
  ['has two equal PIDs', () => 'Name:\tnode\nNSpid:\t400\t400\n', 400],
  ['has parent and child PIDs', () => `Name:\tnode\nNSpid:\t2400\t${process.pid}\n`],
  ['is missing', () => 'Name:\tnode\n'],
  ['cannot be read', () => { throw new Error('unreadable /proc/self/status') }],
  ['has a different single PID', () => `Name:\tnode\nNSpid:\t${process.pid + 1}\n`],
  ['has a nondecimal PID', () => 'Name:\tnode\nNSpid:\tnot-a-pid\n'],
  ['has trailing data', () => `Name:\tnode\nNSpid:\t${process.pid} extra\n`],
  ['is empty', () => 'Name:\tnode\nNSpid:\t\n'],
]) {
  test(`preflight omits the PID namespace when NSpid ${scenario}`, async () => {
    const { processStartIdentity } = await import('../scripts/preflight.mjs')
    const boot = '00000000-0000-4000-8000-000000000001'
    const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0`
    const originalPid = Object.getOwnPropertyDescriptor(process, 'pid')
    if (readerPid !== undefined) Object.defineProperty(process, 'pid', { ...originalPid, value: readerPid })
    try {
      const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
        : path === '/proc/self/status' ? status() : stat
      // A legacy /proc/self lookup can resolve to the reader's PID even for an inherited mount.
      const readLink = path => path.endsWith('/time') ? 'time:[1]' : path.endsWith('/pid') ? 'pid:[2]' : String(process.pid)
      assert.equal(processStartIdentity(42, { platform: 'linux', readText, readLink }), `linux:${boot}:12345:time:[1]`)
    } finally {
      if (readerPid !== undefined) Object.defineProperty(process, 'pid', originalPid)
    }
  })
}

for (const [isWatched, isEqual] of [[false, false], [false, true], [true, false], [true, true]]) {
  const folder = isWatched ? 'watched' : 'own'
  test(`preflight keeps a live Linux marker read through an inherited procfs mount${isEqual ? ' with equal PIDs' : ''} in its ${folder} folder`, async t => {
    const { processStartIdentity } = await import('../scripts/preflight.mjs')
    const child = await startUnrelatedProcess()
    try {
      const f = fixture(t)
      f.write('tests/inherited-proc.test.mjs', '')
      const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
      mkdirSync(directory, { mode: 0o700 })
      const name = `${child.pid}-00000000-0000-4000-8000-000000000038.lock`
      const marker = join(directory, name)
      const boot = '00000000-0000-4000-8000-000000000001'
      const recorded = `linux:${boot}:12345:time:[1]:pid:[2]`
      writeFileSync(`${marker}.start`, JSON.stringify(recorded))
      writeFileSync(marker, '')
      const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 18345 0`
      const mountPid = isEqual ? process.pid : process.pid + 1
      const paths = []
      const readText = path => {
        paths.push(path)
        return path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
          : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${mountPid}\t${process.pid}\n` : stat
      }
      // A legacy /proc/self lookup resolves the PID in the procfs mount's namespace.
      const readLink = path => path.endsWith('/time') ? 'time:[1]' : path.endsWith('/pid') ? 'pid:[2]' : String(mountPid)
      const identities = []
      let testStarts = 0
      const run = (program, args, options) => {
        if (args.includes('--test')) {
          testStarts++
          return { status: 0, stdout: '# tests 1\n# fail 0\n', stderr: '' }
        }
        return f.run(program, args, options)
      }
      const checks = await f.check({
        fallbackLockPath: isWatched ? directory : null,
        readProcessIdentity: pid => {
          const identity = processStartIdentity(pid, { platform: 'linux', readText, readLink })
          identities.push([pid, identity])
          return identity
        },
        run,
      })
      assert.equal(testStarts, 0)
      const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
      assert.ok(failure)
      assert.ok(failure.message.includes(', its time or process ID namespace differs or could not be read, so the owner could not be confirmed'))
      assert.ok(failure.message.includes(name))
      assert.equal(paths.includes(`/proc/${child.pid}/stat`), false)
      assert.ok(identities.some(([pid, identity]) => pid === process.pid && identity === `linux:${boot}:18345:time:[1]`))
      assert.equal(existsSync(marker), true)
      assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), recorded)
      if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
    } finally {
      await stopUnrelatedProcess(child)
    }
  })
}

for (const isWatched of [false, true]) {
  test(`preflight keeps a live Linux marker written under another time namespace in its ${isWatched ? 'watched' : 'own'} folder`, async t => {
    const f = fixture(t)
    f.write('tests/time-namespace.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const name = `${process.pid}-00000000-0000-4000-8000-000000000034.lock`
    const marker = join(directory, name)
    const boot = '00000000-0000-4000-8000-000000000001'
    writeFileSync(`${marker}.start`, JSON.stringify(`linux:${boot}:12345:time:[1]:pid:[1]`))
    writeFileSync(marker, '')
    const checks = await f.check({
      fallbackLockPath: isWatched ? directory : null,
      readProcessIdentity: () => `linux:${boot}:18345:time:[2]:pid:[1]`,
      onProgress: () => assert.fail('tests must not start'),
    })
    const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
    assert.ok(failure)
    assert.match(failure.message, /time or process ID namespace/)
    assert.ok(failure.message.includes(name))
    assert.equal(existsSync(marker), true)
  })
}

for (const isWatched of [false, true]) {
  for (const [side, recorded, read] of [['record', 'linux:00000000-0000-4000-8000-000000000001:12345:pid:[1]', 'linux:00000000-0000-4000-8000-000000000001:18345:time:[2]:pid:[1]'], ['reader', 'linux:00000000-0000-4000-8000-000000000001:12345:time:[1]:pid:[1]', 'linux:00000000-0000-4000-8000-000000000001:18345:pid:[1]']]) {
    test(`preflight keeps a live Linux marker when the ${side} has no time namespace in its ${isWatched ? 'watched' : 'own'} folder`, async t => {
      const f = fixture(t)
      f.write('tests/missing-namespace.test.mjs', '')
      const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
      mkdirSync(directory, { mode: 0o700 })
      const name = `${process.pid}-00000000-0000-4000-8000-000000000036.lock`
      const marker = join(directory, name)
      writeFileSync(`${marker}.start`, JSON.stringify(recorded))
      writeFileSync(marker, '')
      const checks = await f.check({ fallbackLockPath: isWatched ? directory : null, readProcessIdentity: () => read, onProgress: () => assert.fail('tests must not start') })
      const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
      assert.ok(failure)
      assert.match(failure.message, /time or process ID namespace differs or could not be read/)
      assert.ok(failure.message.includes(name))
      assert.equal(existsSync(marker), true)
    })
  }
}

for (const isWatched of [false, true]) {
  const folder = isWatched ? 'watched' : 'own'
  for (const [scenario, suffix, hasReaderPid] of [
    ['from a different PID namespace', ':pid:[1]', true],
    ['without a recorded PID namespace', '', true],
    ['when the reader has no PID namespace', ':pid:[1]', false],
  ]) {
    test(`preflight keeps a live Linux marker ${scenario} in its ${folder} folder`, async t => {
      const { processStartIdentity } = await import('../scripts/preflight.mjs')
      const f = fixture(t)
      f.write('tests/pid-namespace.test.mjs', '')
      const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
      mkdirSync(directory, { mode: 0o700 })
      const name = `${process.pid}-00000000-0000-4000-8000-000000000037.lock`
      const marker = join(directory, name)
      const boot = '00000000-0000-4000-8000-000000000001'
      const recorded = `linux:${boot}:12345:time:[1]${suffix}`
      writeFileSync(`${marker}.start`, JSON.stringify(recorded))
      writeFileSync(marker, '')
      const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 18345 0`
      const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
        : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
      const readLink = path => {
        if (path.endsWith('/time')) return 'time:[1]'
        if (hasReaderPid) return 'pid:[2]'
        throw new Error('no PID namespace')
      }
      let testStarts = 0
      const run = (program, args, options) => {
        if (args.includes('--test')) {
          testStarts++
          return { status: 1, stdout: '# tests 1\n# fail 1\n', stderr: '' }
        }
        return f.run(program, args, options)
      }
      const checks = await f.check({
        fallbackLockPath: isWatched ? directory : null,
        readProcessIdentity: pid => processStartIdentity(pid, { platform: 'linux', readText, readLink }),
        run,
      })
      assert.equal(testStarts, 0)
      const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
      assert.ok(failure)
      assert.ok(failure.message.includes(', its time or process ID namespace differs or could not be read, so the owner could not be confirmed'))
      assert.ok(failure.message.includes(name))
      assert.equal(existsSync(marker), true)
      assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), recorded)
      if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
    })
  }
}

// Only these serial, disposable marker fixtures see this PID as dead. All other probes
// keep their native behavior, and the global method is restored even on a failed assertion.
const withSyntheticDeadMarker = async (pid, check) => {
  const originalKill = process.kill
  let probes = 0
  process.kill = (target, signal) => {
    if (target === pid && signal === 0) {
      probes++
      throw Object.assign(new Error('synthetic absent marker owner'), { code: 'ESRCH' })
    }
    return Reflect.apply(originalKill, process, [target, signal])
  }
  try { return await check(() => probes) } finally { process.kill = originalKill }
}

for (const isWatched of [false, true]) {
  const folder = isWatched ? 'watched' : 'own'
  for (const [scenario, recorded, current] of [
    ['a different namespace', syntheticIdentity(1).replace('pid:[2]', 'pid:[3]'), syntheticIdentity(process.pid)],
    ['a missing recorded namespace', syntheticIdentity(1).replace(':pid:[2]', ''), syntheticIdentity(process.pid)],
    ['a missing reader namespace', syntheticIdentity(1), syntheticIdentity(process.pid).replace(':pid:[2]', '')],
    ['an unreadable reader', syntheticIdentity(1), null],
    ['an unreadable record', null, syntheticIdentity(process.pid)],
    ['a legacy record', undefined, syntheticIdentity(process.pid)],
  ]) {
    test(`preflight retains a marker with ${scenario} even when its PID is absent locally in its ${folder} folder`, { concurrency: false }, async t => {
      const f = fixture(t)
      f.write('tests/foreign-pid.test.mjs', '')
      const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
      mkdirSync(directory, { mode: 0o700 })
      const name = '2147483647-00000000-0000-4000-8000-000000000039.lock'
      const marker = join(directory, name)
      if (recorded !== undefined) writeFileSync(`${marker}.start`, JSON.stringify(recorded))
      writeFileSync(marker, '')
      let testStarts = 0
      let ownerReads = 0
      const checks = await withSyntheticDeadMarker(2147483647, async probes => {
        const result = await f.check({
          fallbackLockPath: isWatched ? directory : null,
          readProcessIdentity: pid => {
            if (pid !== process.pid) ownerReads++
            return current
          },
          run: (program, args, options) => {
            if (args.includes('--test')) {
              testStarts++
              return { status: 0, stdout: '# tests 1\n# fail 0\n', stderr: '' }
            }
            return f.run(program, args, options)
          },
        })
        assert.equal(probes(), 0, 'a foreign or unknown PID namespace must block before process.kill(pid, 0)')
        return result
      })
      assert.equal(testStarts, 0)
      assert.equal(ownerReads, 0)
      const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
      assert.ok(failure)
      assert.ok(failure.message.includes(name))
      assert.equal(readFileSync(marker, 'utf8'), '')
      if (recorded === undefined) assert.equal(existsSync(`${marker}.start`), false)
      else assert.equal(readFileSync(`${marker}.start`, 'utf8'), JSON.stringify(recorded))
      assert.deepEqual(readdirSync(directory).sort(), recorded === undefined ? [name] : [name, `${name}.start`].sort())
      if (isWatched) assert.deepEqual(readdirSync(f.lockPath), [])
    })
  }

  test(`preflight still ignores a dead same-namespace owner and only cleans its ${folder} folder when owned`, { concurrency: false }, async t => {
    const f = fixture(t)
    f.write('tests/dead-same-namespace.test.mjs', '')
    const directory = isWatched ? join(f.root, 'watched-lock') : f.lockPath
    mkdirSync(directory, { mode: 0o700 })
    const name = '2147483647-00000000-0000-4000-8000-000000000040.lock'
    const marker = join(directory, name)
    writeFileSync(`${marker}.start`, JSON.stringify(syntheticIdentity(1)))
    writeFileSync(marker, '')
    let testStarts = 0
    const checks = await withSyntheticDeadMarker(2147483647, async probes => {
      const result = await f.check({
        fallbackLockPath: isWatched ? directory : null,
        run: (program, args, options) => {
          if (args.includes('--test')) {
            testStarts++
            return { status: 0, stdout: '# tests 1\n# fail 0\n', stderr: '' }
          }
          return f.run(program, args, options)
        },
      })
      assert.equal(probes(), 1, 'a verified same-namespace owner still receives the ordinary liveness probe')
      return result
    })
    assert.equal(testStarts, 1)
    assert.ok(has(checks, 'PASS', 'tests/dead-same-namespace.test.mjs: 1 tests, 0 failed'))
    assert.equal(existsSync(marker), isWatched)
    assert.equal(existsSync(`${marker}.start`), isWatched)
    assert.deepEqual(readdirSync(f.lockPath), [])
  })
}

test('preflight still frees a reused Linux PID read through the same time and PID namespaces', async t => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const f = fixture(t)
  f.write('tests/same-namespace.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000035.lock`)
  const boot = '00000000-0000-4000-8000-000000000001'
  writeFileSync(`${marker}.start`, JSON.stringify(`linux:${boot}:12345:time:[1]:pid:[2]`))
  writeFileSync(marker, '')
  const stat = `42 (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 18345 0`
  const readText = path => path === '/proc/sys/kernel/random/boot_id' ? `${boot}\n`
    : path === '/proc/self/status' ? `Name:\tnode\nNSpid:\t${process.pid}\n` : stat
  const readLink = path => path.endsWith('/time') ? 'time:[1]' : 'pid:[2]'
  const checks = await f.check({ readProcessIdentity: pid => processStartIdentity(pid, { platform: 'linux', readText, readLink }) })
  assert.ok(has(checks, 'PASS', 'tests/same-namespace.test.mjs: 1 tests, 0 failed'))
  assert.equal(existsSync(marker), false)
})

for (const account of ['abc', 'agent']) test(`preflight names the exact .lock file and folder even when the account name ${account} appears inside them`, async t => {
  const f = fixture(t)
  f.write('tests/exact-name.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const name = `${process.pid}-00000000-0000-4000-8000-00000000abc1.lock`
  writeFileSync(join(f.lockPath, `${name}.start`), 'null')
  writeFileSync(join(f.lockPath, name), '')
  const saved = { USERNAME: process.env.USERNAME, USER: process.env.USER }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.USERNAME = account
  process.env.USER = account
  const checks = await f.check({ onProgress: () => assert.fail('tests must not start') })
  const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
  assert.ok(failure)
  assert.ok(failure.message.includes(name), failure.message)
  assert.ok(failure.message.includes(".agent-board-preflight-tests-* folder"), failure.message)
})

test('preflight keeps an identity marker when its recorded identity is unknown or malformed', async t => {
  const f = fixture(t)
  f.write('tests/unreadable-record.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000028.lock`)
  writeFileSync(marker, '')
  for (const text of ['null', 'malformed']) {
    writeFileSync(`${marker}.start`, text)
    const checks = await f.check()
    assert.ok(has(checks, 'FAIL', 'process start time could not be read'))
    assert.equal(existsSync(marker), true)
    assert.equal(readFileSync(`${marker}.start`, 'utf8'), text)
  }
})

test('preflight reports an unreadable start when a process reader times out', async t => {
  const { processStartIdentity } = await import('../scripts/preflight.mjs')
  const f = fixture(t)
  f.write('tests/timeout-owner.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000029.lock`)
  writeFileSync(`${marker}.start`, JSON.stringify('synthetic:original'))
  writeFileSync(marker, '')
  let runs = 0
  const checks = await f.check({
    lockPlatform: 'darwin',
    readProcessIdentity: pid => processStartIdentity(pid, { platform: 'darwin', run: () => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL', status: null }) }),
    onProgress: () => { runs++ },
  })
  assert.ok(has(checks, 'FAIL', 'process start time could not be read'))
  assert.equal(runs, 0)
  assert.equal(existsSync(marker), true)
})

test('preflight keeps and blocks on a long-running live owner in its own folder', async t => {
  const f = fixture(t)
  f.write('tests/long-owner.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000021.lock`)
  writeFileSync(marker, '')
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000 - 60_000)
  utimesSync(marker, old, old)
  const checks = await f.check()
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.equal(existsSync(marker), true)
})

test('preflight keeps and blocks on a long-running live owner in a watched folder', async t => {
  const f = fixture(t)
  f.write('tests/watched-owner.test.mjs', '')
  const fallbackLockPath = join(f.root, 'watched-lock')
  mkdirSync(fallbackLockPath, { mode: 0o700 })
  const marker = join(fallbackLockPath, `${process.pid}-00000000-0000-4000-8000-000000000022.lock`)
  writeFileSync(marker, '')
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000 - 60_000)
  utimesSync(marker, old, old)
  const checks = await f.check({ fallbackLockPath })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.equal(existsSync(marker), true)
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight removes an own-folder marker when its live PID was reused', async t => {
  const f = fixture(t)
  f.write('tests/reused-owner.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000023.lock`)
  writeFileSync(`${marker}.start`, JSON.stringify(syntheticIdentity(0)))
  writeFileSync(marker, '')
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/reused-owner.test.mjs: 1 tests, 0 failed'))
  assert.equal(existsSync(marker), false)
})

test('preflight says when a blocking owner has an unknown start time', async t => {
  const f = fixture(t)
  f.write('tests/unknown-owner.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000024.lock`)
  writeFileSync(marker, '')
  const checks = await f.check()
  const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
  assert.ok(failure)
  assert.match(failure.message, new RegExp(`process ${process.pid}\\b`))
  assert.match(failure.message, /owner could not be confirmed/)
  assert.match(failure.message, /delete its \.lock file/)
  assert.equal(existsSync(marker), true)
})

test('preflight keeps a watched marker and reports when its live owner has an unknown start time', async t => {
  const f = fixture(t)
  f.write('tests/watched-unknown-owner.test.mjs', '')
  const fallbackLockPath = join(f.root, 'watched-lock')
  mkdirSync(fallbackLockPath, { mode: 0o700 })
  const marker = join(fallbackLockPath, `${process.pid}-00000000-0000-4000-8000-000000000030.lock`)
  writeFileSync(marker, '')
  let runs = 0
  const checks = await f.check({ fallbackLockPath, onProgress: () => { runs++ } })
  const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
  assert.ok(failure)
  assert.match(failure.message, new RegExp(`process ${process.pid}\\b`))
  assert.match(failure.message, /owner could not be confirmed/)
  assert.equal(existsSync(marker), true)
  assert.equal(runs, 0)
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight removes a marker when an unrelated live process reuses its PID', async t => {
  const child = await startUnrelatedProcess()
  try {
    const f = fixture(t)
    f.write('tests/reused-pid.test.mjs', '')
    mkdirSync(f.lockPath, { mode: 0o700 })
    const marker = join(f.lockPath, `${child.pid}-00000000-0000-4000-8000-000000000011.lock`)
    writeFileSync(`${marker}.start`, JSON.stringify(syntheticIdentity(0)))
    writeFileSync(marker, '')
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000 - 60_000)
    utimesSync(marker, old, old)
    let hasCheckedChild = false
    const checks = await f.check({ readProcessIdentity: pid => {
      if (pid === child.pid) hasCheckedChild = true
      return syntheticIdentity(pid)
    } })
    assert.equal(hasCheckedChild, true)
    assert.ok(has(checks, 'PASS', 'tests/reused-pid.test.mjs: 1 tests, 0 failed'))
    assert.equal(existsSync(marker), false)
  } finally {
    await stopUnrelatedProcess(child)
  }
})

test('preflight removes a marker with a different identity for a live process on Linux', { skip: process.platform !== 'linux' ? 'this exercises the Linux process reader' : false }, async t => {
  const child = await startUnrelatedProcess()
  try {
    const f = fixture(t)
    f.write('tests/reused-start.test.mjs', '')
    mkdirSync(f.lockPath, { mode: 0o700 })
    const marker = join(f.lockPath, `${child.pid}-00000000-0000-4000-8000-000000000012.lock`)
    writeFileSync(marker, '')
    const { processStartIdentity } = await import('../scripts/preflight.mjs')
    const identity = processStartIdentity(child.pid)
    // Only an identity that names both namespaces can be compared; other tests cover incomplete identities.
    const parts = /^(linux:[^:]+:)(\d+)(:time:\[\d+\]:pid:\[\d+\])$/.exec(identity ?? '')
    if (!parts) return t.skip('the Linux process identity or one of its namespaces is unavailable')
    // Same boot and namespaces, another start tick: the marker's owner was a different process.
    writeFileSync(`${marker}.start`, JSON.stringify(`${parts[1]}${Number(parts[2]) + 1}${parts[3]}`))
    const checks = await f.check({ readProcessIdentity: processStartIdentity })
    assert.ok(has(checks, 'PASS', 'tests/reused-start.test.mjs: 1 tests, 0 failed'))
    assert.equal(existsSync(marker), false)
  } finally {
    await stopUnrelatedProcess(child)
  }
})

test('preflight leaves a reused-PID marker in a watched folder and still runs', async t => {
  const f = fixture(t)
  f.write('tests/watched-expired.test.mjs', '')
  const fallbackLockPath = join(f.root, 'watched-lock')
  mkdirSync(fallbackLockPath, { mode: 0o700 })
  const marker = join(fallbackLockPath, `${process.pid}-00000000-0000-4000-8000-000000000013.lock`)
  writeFileSync(`${marker}.start`, JSON.stringify(syntheticIdentity(0)))
  writeFileSync(marker, '')
  const checks = await f.check({ fallbackLockPath })
  assert.ok(has(checks, 'PASS', 'tests/watched-expired.test.mjs: 1 tests, 0 failed'))
  assert.equal(existsSync(marker), true)
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight reports the newest live marker across its own and watched folders', async t => {
  const f = fixture(t)
  f.write('tests/newest-lock.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const fallbackLockPath = join(f.root, 'watched-lock')
  mkdirSync(fallbackLockPath, { mode: 0o700 })
  const older = join(f.lockPath, `${process.pid}-00000000-0000-4000-8000-000000000014.lock`)
  const newer = join(fallbackLockPath, `${process.ppid}-00000000-0000-4000-8000-000000000015.lock`)
  writeFileSync(older, '')
  writeFileSync(newer, '')
  const future = new Date(Date.now() + 60_000)
  utimesSync(newer, future, future)
  const checks = await f.check({ fallbackLockPath, onProgress: () => assert.fail('tests must not start') })
  const failure = checks.find(item => item.state === 'FAIL' && item.message.includes('another preflight test run'))
  assert.ok(failure)
  assert.match(failure.message, new RegExp(`process ${process.ppid}\\b`))
  assert.equal(existsSync(older), true)
  assert.equal(existsSync(newer), true)
})

test('preflight does not remove a lock acquired by a replacement owner', async t => {
  const f = fixture(t)
  f.write('tests/replacement.test.mjs', '')
  const replacement = `${process.pid}-00000000-0000-4000-8000-000000000002.lock`
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
  mkdirSync(f.lockPath, { mode: 0o700 })
  const stale = join(f.lockPath, '2147483647-00000000-0000-4000-8000-000000000001.lock')
  writeFileSync(`${stale}.start`, JSON.stringify(syntheticIdentity(1)))
  writeFileSync(stale, '')
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
  mkdirSync(f.lockPath, { mode: 0o700 })
  const marker = join(f.lockPath, '2147483647-00000000-0000-4000-8000-000000000001.lock')
  writeFileSync(`${marker}.start`, JSON.stringify(syntheticIdentity(1)))
  writeFileSync(marker, '')
  const checks = await f.check()
  assert.ok(checks.some(item => item.state === 'PASS' && item.message.startsWith('tests/interrupted.test.mjs:') && item.message.includes('0 failed')))
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('preflight gives different accounts separate default test lock directories', async () => {
  const module = await import('../scripts/preflight.mjs')
  assert.equal(typeof module.accountTestLockPath, 'function')
  const shared = join('synthetic-root', 'shared-temp')
  const unixOne = module.accountTestLockPath({ platform: 'linux', temp: shared, account: { uid: 1001, homedir: '/synthetic/one' } })
  const unixTwo = module.accountTestLockPath({ platform: 'linux', temp: shared, account: { uid: 1002, homedir: '/synthetic/two' } })
  assert.notEqual(unixOne, unixTwo)
  assert.notEqual(module.accountTestLockPath({ platform: 'linux', temp: shared, account: { uid: 1002, homedir: '/synthetic/one' } }), unixOne)
  const windowsOne = module.accountTestLockPath({ platform: 'win32', temp: shared, account: { uid: -1, homedir: 'C:\\Users\\Synthetic One' } })
  const windowsTwo = module.accountTestLockPath({ platform: 'win32', temp: shared, account: { uid: -1, homedir: 'C:\\Users\\Synthetic Two' } })
  assert.notEqual(windowsOne, windowsTwo)
  assert.equal(module.accountTestLockPath({ platform: 'win32', temp: shared, account: { uid: 999, homedir: 'C:\\Users\\Synthetic One' } }), windowsOne)
  assert.equal(dirname(unixOne), '/synthetic/one'.replaceAll('/', process.platform === 'win32' ? '\\' : '/'))
  assert.equal(dirname(windowsOne), 'C:\\Users\\Synthetic One')
})

test('preflight keeps the same account lock when TEMP changes', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const account = { uid: 1001, homedir: join('synthetic-root', 'account-home') }
    const first = accountTestLockPath({ platform, account, temp: join('synthetic-root', 'temp-one') })
    const second = accountTestLockPath({ platform, account, temp: join('synthetic-root', 'temp-two') })
    assert.equal(first, second)
    assert.equal(dirname(first), account.homedir)
  }
})

test('preflight CLI runs with different TEMP values still exclude each other', t => {
  const f = fixture(t)
  f.write('tests/temp-lock.test.mjs', '')
  const firstTemp = join(f.root, 'temp-one')
  const secondTemp = join(f.root, 'temp-two')
  mkdirSync(firstTemp)
  mkdirSync(secondTemp)
  const account = { uid: 1001, homedir: f.home }
  const secondCli = join(f.root, 'second-cli.mjs')
  const firstCli = join(f.root, 'first-cli.mjs')
  const resultPath = join(f.root, 'second-result.json')
  const header = `import { accountTestLockPath, main } from ${JSON.stringify(pathToFileURL(script).href)}\nconst lockPath = accountTestLockPath({ account: ${JSON.stringify(account)} })\nconst fallbackLockPath = null\n`
  writeFileSync(secondCli, `${header}process.exitCode = await main(['--no-fetch'], { lockPath, fallbackLockPath })\n`)
  writeFileSync(firstCli, `${header}import { spawnSync } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nprocess.exitCode = await main(['--no-fetch'], { lockPath, fallbackLockPath, onLockPublished: () => {\n  const result = spawnSync(process.execPath, [${JSON.stringify(secondCli)}], { cwd: process.cwd(), env: { ...process.env, TEMP: ${JSON.stringify(secondTemp)}, TMP: ${JSON.stringify(secondTemp)}, TMPDIR: ${JSON.stringify(secondTemp)} }, encoding: 'utf8', timeout: 15000 })\n  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }))\n} })\n`)
  const first = spawnSync(process.execPath, [firstCli], {
    cwd: f.cwd, env: { ...f.env, TEMP: firstTemp, TMP: firstTemp, TMPDIR: firstTemp }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(first.error, undefined)
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /RUN tests\/temp-lock\.test\.mjs/)
  const second = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(second.error, undefined)
  assert.equal(second.status, 1, second.stdout + second.stderr)
  assert.match(second.stdout, /FAIL another preflight test run is already active/)
  assert.doesNotMatch(second.stdout, /RUN tests\//)
  assert.deepEqual(readdirSync(accountTestLockPath({ account })), [])
})

test('preflight ignores unfamiliar lock entries without deleting them', async t => {
  const f = fixture(t)
  f.write('tests/stray.test.mjs', '')
  mkdirSync(f.lockPath, { mode: 0o700 })
  const names = ['notes.txt', `${process.pid}-not-a-uuid.lock`, `${process.pid}-00000000-0000-4000-8000-000000000003.lock`]
  for (const name of names) writeFileSync(join(f.lockPath, name), 'synthetic stray')
  const impossibleOwners = ['2147483648', '9007199254740992', '9'.repeat(80)].map(pid => `${pid}-00000000-0000-4000-8000-000000000004.lock`)
  for (const name of impossibleOwners) writeFileSync(join(f.lockPath, name), '')
  const directory = '2147483647-00000000-0000-4000-8000-000000000001.lock'
  mkdirSync(join(f.lockPath, directory), { mode: 0o700 })
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/stray.test.mjs: 1 tests, 0 failed'))
  assert.deepEqual(readdirSync(f.lockPath).sort(), [...names, ...impossibleOwners, directory].sort())
  for (const name of names) assert.equal(readFileSync(join(f.lockPath, name), 'utf8'), 'synthetic stray')
  for (const name of impossibleOwners) assert.equal(readFileSync(join(f.lockPath, name), 'utf8'), '')
})

test('preflight rejects a non-directory lock root without starting tests or exposing its path', async t => {
  const f = fixture(t)
  f.write('tests/unsafe-root.test.mjs', '')
  writeFileSync(f.lockPath, 'synthetic sentinel')
  const checks = await f.check({ onProgress: () => assert.fail('tests must not start'), onLockPublished: () => assert.fail('a marker must not be published') })
  assert.ok(has(checks, 'FAIL', 'test lock directory is not a directory'))
  assert.equal(readFileSync(f.lockPath, 'utf8'), 'synthetic sentinel')
  assert.equal(JSON.stringify(checks).includes(f.root), false)
})

test('preflight reports a deidentified failure when a synthetic lock root cannot be created', async t => {
  const f = fixture(t)
  f.write('tests/missing-root.test.mjs', '')
  const checks = await f.check({ lockPath: join(f.root, 'missing-parent', 'private-lock'), onLockPublished: () => assert.fail('a marker must not be published') })
  assert.ok(has(checks, 'FAIL', 'test lock directory could not be created'))
  assert.equal(JSON.stringify(checks).includes(f.root), false)
  assert.equal(existsSync(join(f.root, 'missing-parent')), false)
})

test('preflight rejects a symbolic-link lock root without changing its target', async t => {
  const f = fixture(t)
  f.write('tests/symlink-root.test.mjs', '')
  const target = join(f.root, 'synthetic-target')
  mkdirSync(target, { mode: 0o700 })
  writeFileSync(join(target, 'sentinel'), 'untouched')
  try { symlinkSync(target, f.lockPath, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('this platform cannot create a synthetic directory link')
    throw error
  }
  const checks = await f.check({ onProgress: () => assert.fail('tests must not start') })
  assert.ok(has(checks, 'FAIL', 'test lock directory is a symbolic link'))
  assert.deepEqual(readdirSync(target), ['sentinel'])
  assert.equal(lstatSync(f.lockPath).isSymbolicLink(), true)
})

test('preflight rejects synthetic Unix lock ownership and writable directory modes', async () => {
  const { testLockDirectoryProblem } = await import('../scripts/preflight.mjs')
  const stat = { isSymbolicLink: () => false, isDirectory: () => true, uid: 1001, mode: 0o40700 }
  const unix = { platform: 'linux', uid: 1001 }
  assert.equal(testLockDirectoryProblem(stat, unix), null)
  assert.match(testLockDirectoryProblem({ ...stat, isSymbolicLink: () => true }, unix), /symbolic link/)
  assert.match(testLockDirectoryProblem({ ...stat, isDirectory: () => false }, unix), /not a directory/)
  assert.match(testLockDirectoryProblem({ ...stat, uid: 1002 }, unix), /belongs to another account/)
  for (const mode of [0o40720, 0o40702, 0o41777]) assert.match(testLockDirectoryProblem({ ...stat, mode }, unix), /writable by group or others/)
  assert.equal(testLockDirectoryProblem({ ...stat, mode: 0o40755 }, unix), null)
})

test('preflight creates private Unix lock directories and refuses writable fixtures without chmod', { skip: process.platform === 'win32' ? 'native Unix mode checks are unavailable on Windows' : false }, async t => {
  const f = fixture(t)
  f.write('tests/mode-root.test.mjs', '')
  assert.ok(has(await f.check(), 'PASS', 'tests/mode-root.test.mjs: 1 tests, 0 failed'))
  assert.equal(lstatSync(f.lockPath).mode & 0o777, 0o700)
  for (const mode of [0o720, 0o702]) {
    chmodSync(f.lockPath, mode)
    const checks = await f.check({ onProgress: () => assert.fail('tests must not start') })
    assert.ok(has(checks, 'FAIL', 'test lock directory is writable by group or others'))
    assert.equal(lstatSync(f.lockPath).mode & 0o777, mode)
    assert.deepEqual(readdirSync(f.lockPath), [])
  }
})

test('preflight lock fixtures stay private and allow touched tests under umask 0007', { skip: process.platform === 'win32' ? 'native Unix mode checks are unavailable on Windows' : false }, async t => {
  const previous = process.umask(0o007)
  try {
    const f = fixture(t)
    f.write('tests/umask.test.mjs', '')
    mkdirSync(f.lockPath, { mode: 0o700 })
    assert.equal(lstatSync(f.lockPath).mode & 0o777, 0o700)
    assert.ok(has(await f.check(), 'PASS', 'tests/umask.test.mjs: 1 tests, 0 failed'))
    assert.deepEqual(readdirSync(f.lockPath), [])
  } finally {
    process.umask(previous)
  }
})

const restrictedSkip = process.platform === 'win32' ? 'the shared fallback lock is for Unix accounts only'
  : process.getuid?.() === 0 ? 'root ignores the read-only folder this test needs' : false

// A home folder this account cannot write, with the shared fallback's parent beside it.
// The read-only folders live in their own root, so the fixture's cleanup never meets them before they are writable again.
const restricted = (t, { parentMode = 0o1777, homeLock } = {}) => {
  const f = fixture(t)
  const outer = mkdtempSync(join(tmpdir(), 'preflight-restricted-'))
  const readOnly = join(outer, 'read-only-home')
  mkdirSync(readOnly)
  if (homeLock) {
    homeLock(join(readOnly, 'lock'))
    chmodSync(join(readOnly, 'lock'), 0o500)
  }
  chmodSync(readOnly, 0o500)
  t.after(() => {
    chmodSync(readOnly, 0o700)
    if (homeLock) chmodSync(join(readOnly, 'lock'), 0o700)
    rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const shared = join(outer, 'shared')
  mkdirSync(shared)
  chmodSync(shared, parentMode)
  const lockPath = join(readOnly, 'lock')
  const fallbackLockPath = join(shared, 'lock')
  return { ...f, lockPath, fallbackLockPath, check: options => f.check({ lockPath, fallbackLockPath, ...options }) }
}

test('preflight names the shared fallback lock from the account, not from TEMP, and has none on Windows', () => {
  assert.equal(accountFallbackLockPath({ platform: 'linux', account: { uid: 1001, homedir: '/synthetic/one' } }), '/tmp/.agent-board-preflight-tests-1001')
  assert.equal(accountFallbackLockPath({ platform: 'darwin', account: { uid: 501, homedir: '/synthetic/two' } }), '/tmp/.agent-board-preflight-tests-501')
  assert.equal(accountFallbackLockPath({ platform: 'win32', account: { uid: -1, homedir: 'C:\\Users\\Synthetic' } }), null)
})

test('preflight accepts only a sticky or private parent for the shared fallback lock', async () => {
  const { sharedParentProblem } = await import('../scripts/preflight.mjs')
  const stat = mode => ({ isDirectory: () => true, mode })
  assert.equal(sharedParentProblem(stat(0o41777), { platform: 'linux' }), null)
  assert.equal(sharedParentProblem(stat(0o40755), { platform: 'linux' }), null)
  assert.match(sharedParentProblem(stat(0o40777), { platform: 'linux' }), /writable by others without the sticky bit/)
  assert.match(sharedParentProblem({ isDirectory: () => false, mode: 0o41777 }, { platform: 'linux' }), /not a directory/)
  assert.match(sharedParentProblem(stat(0o41777), { platform: 'win32' }), /no shared fallback on Windows/)
})

test('preflight runs touched tests under the shared fallback lock when the home folder is read-only', { skip: restrictedSkip }, async t => {
  const f = restricted(t)
  f.write('tests/restricted.test.mjs', '')
  let hasPublished = false
  const checks = await f.check({ onLockPublished: () => {
    const name = readdirSync(f.fallbackLockPath).find(name => name.endsWith('.lock'))
    const marker = join(f.fallbackLockPath, name)
    assert.equal(lstatSync(marker).size, 0)
    assert.equal(JSON.parse(readFileSync(`${marker}.start`, 'utf8')), syntheticIdentity(process.pid))
    hasPublished = true
  } })
  assert.equal(hasPublished, true)
  assert.ok(has(checks, 'PASS', 'tests/restricted.test.mjs: 1 tests, 0 failed'))
  assert.ok(has(checks, 'PASS', "this account's shared fallback folder"))
  assert.equal(existsSync(f.lockPath), false)
  assert.equal(lstatSync(f.fallbackLockPath).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(f.fallbackLockPath), [])
})

test('a restricted preflight starts no test while a live run holds the read-only home lock', { skip: restrictedSkip }, async t => {
  const live = `${process.pid}-00000000-0000-4000-8000-000000000005.lock`
  const f = restricted(t, { homeLock: path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, live), '') } })
  f.write('tests/restricted-live.test.mjs', '')
  const checks = await f.check({ onProgress: line => { if (line.startsWith('RUN ')) assert.fail('tests must not start') } })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.deepEqual(readdirSync(f.lockPath), [live])
  assert.deepEqual(readdirSync(f.fallbackLockPath), [])
})

test('a preflight with a writable home starts no test while a restricted run holds the shared fallback lock', async t => {
  const f = fixture(t)
  f.write('tests/home-live.test.mjs', '')
  const fallbackLockPath = join(f.root, 'shared-lock')
  mkdirSync(fallbackLockPath, { mode: 0o700 })
  const live = `${process.pid}-00000000-0000-4000-8000-000000000006.lock`
  writeFileSync(join(fallbackLockPath, live), '')
  const checks = await f.check({ fallbackLockPath, onProgress: line => { if (line.startsWith('RUN ')) assert.fail('tests must not start') } })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.deepEqual(readdirSync(fallbackLockPath), [live])
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('a preflight with a writable home meets a restricted run whose fallback folder appears after its first look', async t => {
  const f = fixture(t)
  f.write('tests/late-fallback.test.mjs', '')
  const fallbackLockPath = join(f.root, 'late-shared-lock')
  const live = `${process.pid}-00000000-0000-4000-8000-000000000007.lock`
  const checks = await f.check({
    fallbackLockPath,
    onLockPublished: () => { mkdirSync(fallbackLockPath, { mode: 0o700 }); writeFileSync(join(fallbackLockPath, live), '') },
    onProgress: line => { if (line.startsWith('RUN ')) assert.fail('tests must not start') },
  })
  assert.ok(has(checks, 'FAIL', 'another preflight test run is already active'))
  assert.deepEqual(readdirSync(fallbackLockPath), [live])
  assert.deepEqual(readdirSync(f.lockPath), [])
})

test('a restricted preflight leaves a stale marker in the read-only home lock alone and still runs', { skip: restrictedSkip }, async t => {
  const stale = '2147483647-00000000-0000-4000-8000-000000000008.lock'
  const f = restricted(t, { homeLock: path => {
    mkdirSync(path, { mode: 0o700 })
    writeFileSync(join(path, `${stale}.start`), JSON.stringify(syntheticIdentity(1)))
    writeFileSync(join(path, stale), '')
  } })
  f.write('tests/restricted-stale.test.mjs', '')
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/restricted-stale.test.mjs: 1 tests, 0 failed'))
  assert.deepEqual(readdirSync(f.lockPath).sort(), [stale, `${stale}.start`].sort())
  assert.deepEqual(readdirSync(f.fallbackLockPath), [])
})

test('a restricted preflight refuses a shared parent that others can write without the sticky bit', { skip: restrictedSkip }, async t => {
  const f = restricted(t, { parentMode: 0o777 })
  f.write('tests/unprotected.test.mjs', '')
  const checks = await f.check({ onProgress: line => { if (line.startsWith('RUN ')) assert.fail('tests must not start') }, onLockPublished: () => assert.fail('a marker must not be published') })
  assert.ok(has(checks, 'FAIL', 'writable by others without the sticky bit'))
  assert.equal(existsSync(f.fallbackLockPath), false)
})

test('preflight does not fall back when the home lock exists but is unsafe', async t => {
  const f = fixture(t)
  f.write('tests/unsafe-no-fallback.test.mjs', '')
  writeFileSync(f.lockPath, 'synthetic sentinel')
  const fallbackLockPath = join(f.root, 'unused-fallback')
  const checks = await f.check({ fallbackLockPath, onLockPublished: () => assert.fail('a marker must not be published') })
  assert.ok(has(checks, 'FAIL', 'test lock directory is not a directory'))
  assert.equal(existsSync(fallbackLockPath), false)
})

test('preflight runs a touched nested e2e test', async t => {
  const f = fixture(t)
  f.write('tests/e2e/deeper/nested.test.mjs', "import test from 'node:test'\ntest('a nested fixture runs', () => {})\n")
  assert.ok(has(await f.check(), 'PASS', 'tests/e2e/deeper/nested.test.mjs: 1 tests, 0 failed'))
})

const syntheticTests = count => `import test from 'node:test'\nimport assert from 'node:assert/strict'\n${Array.from({ length: count }, (_, i) => `test('synthetic case ${i}', () => {})\n`).join('')}`
const sizedFixture = (t, text, path = 'tests/sized.test.mjs') => {
  const f = fixture(t)
  f.write(path, text)
  f.commit()
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const runs = []
  const run = (program, args, options) => {
    if (args.includes('--test')) runs.push(args)
    return f.run(program, args, options)
  }
  return { ...f, runs, check: options => f.check({ run, ...options }) }
}

test('preflight leaves a touched test file of more than 150 tests to CI and says it was not run', async t => {
  const f = sizedFixture(t, syntheticTests(151))
  f.write('tests/sized.test.mjs', syntheticTests(151).replace("test('synthetic case 75', () => {})", "test('synthetic case 75', () => { assert.equal(1, 1) })"))
  const checks = await f.check()
  assert.ok(has(checks, 'WARN', 'tests/sized.test.mjs: not run here, since its 151 tests can take longer than preflight\'s ten minutes; CI runs it whole. Run the tests you changed by name (node --test --test-name-pattern "<title>" tests/sized.test.mjs) and list them under Evidence.'), JSON.stringify(checks))
  assert.equal(f.runs.length, 0)
  assert.equal(checks.some(item => item.state !== 'WARN' && item.message.startsWith('tests/sized.test.mjs')), false)
})

test('preflight still runs a touched test file of 150 tests whole', async t => {
  const f = sizedFixture(t, syntheticTests(150))
  f.write('tests/sized.test.mjs', syntheticTests(150).replace("test('synthetic case 75', () => {})", "test('synthetic case 75', () => { assert.equal(1, 1) })"))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/sized.test.mjs: 150 tests, 0 failed.'), JSON.stringify(checks))
  assert.equal(f.runs.length, 1)
  assert.equal(f.runs[0].includes('--test-name-pattern'), false)
})

test('preflight runs whole a touched test file whose fixture text holds more than 150 test lines', async t => {
  // A template literal and a block comment hold test-like lines, after a regular expression with a backtick; one
  // test is real.
  const written = Array.from({ length: 151 }, (_, i) => `test('written case ${i}', () => {})\n`).join('')
  const text = `import test from 'node:test'\nconst tick = /\`/\nconst written = \`\n${written}\`\n/*\ntest('commented', () => {})\n*/\ntest('the one real test', () => {})\n`
  const f = sizedFixture(t, text)
  f.write('tests/sized.test.mjs', text.replace("test('the one real test', () => {})", "test('the one real test', () => { tick.test('`') })"))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/sized.test.mjs: 1 tests, 0 failed.'), JSON.stringify(checks))
  assert.equal(f.runs.length, 1)
})

test('preflight runs whole a touched large test file in a folder CI does not list', async t => {
  const f = sizedFixture(t, syntheticTests(151), 'tests/e2e/deeper/sized.test.mjs')
  f.write('tests/e2e/deeper/sized.test.mjs', syntheticTests(151).replace("test('synthetic case 75', () => {})", "test('synthetic case 75', () => { assert.equal(1, 1) })"))
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'tests/e2e/deeper/sized.test.mjs: 151 tests, 0 failed.'), JSON.stringify(checks))
  assert.equal(f.runs.length, 1)
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

test('a failed touched Node check includes its redacted failing test name', async t => {
  const f = fixture(t)
  const names = [
    String.raw`reads C:\Users\Synthetic Person\private.txt with ?t=syntheticBoardToken ghp_syntheticToken`,
    String.raw`reads D:\Work Files\plan.txt now`,
    'issue #123 has a hash',
  ]
  f.write('tests/failing-name.test.mjs', "import test from 'node:test'\n" + names.map(name => `test(${JSON.stringify(name)}, () => { throw new Error('private diagnostic') })`).join('\n') + '\n')
  f.write('tests/failing-unix-name.test.mjs', "import test from 'node:test'\ntest('reads /tmp/synthetic/Private Projects/repository/secret-plan.txt now', () => { throw new Error('private diagnostic') })\n")
  const fileUrls = [
    'reads file:///tmp/synthetic/Private Projects/repository/secret-plan.txt unix',
    'loads file:///C:/Users/Synthetic Person/Private Projects/plan.txt windows',
    'copies file://synthetic-host/share/Private Projects/secret-plan.txt network',
  ]
  f.write('tests/failing-file-url-name.test.mjs', "import test from 'node:test'\n" + fileUrls.map(name => `test(${JSON.stringify(name)}, () => { throw new Error('private diagnostic') })`).join('\n') + '\n')
  const urlBoundaries = [
    'reads url=file:///home/Synthetic/private.txt assigned',
    'reads [file:///home/Synthetic/private.txt] bracketed',
  ]
  f.write('tests/failing-url-boundary.test.mjs', "import test from 'node:test'\n" + urlBoundaries.map(name => `test(${JSON.stringify(name)}, () => { throw new Error('private diagnostic') })`).join('\n') + '\n')
  const checks = await f.check()
  const failed = checks.find(item => item.state === 'FAIL' && item.message.startsWith('tests/failing-name.test.mjs:'))
  assert.match(failed?.message ?? '', /failed: reads <path> with \?t=<token> <token>/)
  assert.match(failed?.message ?? '', /; reads <path> now; issue #123 has a hash\.$/)
  assert.doesNotMatch(failed?.message ?? '', /Synthetic|Person|Files|syntheticBoardToken|syntheticToken|private diagnostic/)
  const unix = checks.find(item => item.state === 'FAIL' && item.message.startsWith('tests/failing-unix-name.test.mjs:'))
  assert.match(unix?.message ?? '', /failed: reads <path> now\.$/)
  assert.doesNotMatch(unix?.message ?? '', /Private|Projects|repository|secret-plan/)
  const urls = checks.find(item => item.state === 'FAIL' && item.message.startsWith('tests/failing-file-url-name.test.mjs:'))
  assert.match(urls?.message ?? '', /failed: reads <path> unix; loads (?:<path>)+ windows; copies <path> network\.$/)
  assert.doesNotMatch(urls?.message ?? '', /file:|fil<path>|Synthetic|Person|Private|Projects|repository|secret-plan|synthetic-host|share/)
  const punctuation = checks.find(item => item.state === 'FAIL' && item.message.startsWith('tests/failing-url-boundary.test.mjs:'))
  assert.match(punctuation?.message ?? '', /failed: reads url=<path> assigned; reads \[<path>\]? bracketed\.$/)
  assert.doesNotMatch(punctuation?.message ?? '', /\/home|Synthetic|private\.txt|file:/)
})

test('nested touched Node TAP failures keep a bounded useful case name', async t => {
  const f = fixture(t)
  f.write('tests/nested-failures.test.mjs', '')
  const names = [
    'the first nested case fails ' + 'x'.repeat(200),
    'the second nested case fails',
    'the third nested case fails',
    'the fourth nested case is outside the bound',
  ]
  const nested = names.map((name, index) => `    not ok ${index + 1} - ${name}`).join('\n')
  const run = (program, args, options) => args.includes('--test')
    ? {
        status: 1,
        stdout: `TAP version 13\n# Subtest: a parent case\n    not ok 1 - a planned nested case # TODO later\n    not ok 2 - a skipped nested case # SKIP unavailable\n    ---\n    error: |-\n      assertion context\n      ...\n      not ok 99 - private diagnostic is not a case name\n    ...\n${nested}\nnot ok 1 - a parent case\n# tests 7\n# fail 5\n`,
        stderr: '',
      }
    : f.run(program, args, options)
  const checks = await f.check({ run })
  const failed = checks.find(item => item.state === 'FAIL' && item.message.startsWith('tests/nested-failures.test.mjs:'))
  const listed = (failed?.message.split('; failed: ')[1] ?? '').replace(/\.$/, '').split('; ')
  assert.deepEqual(listed, names.slice(0, 3).map(name => name.slice(0, 160)))
  assert.doesNotMatch(failed?.message ?? '', /planned nested|skipped nested|private diagnostic|fourth nested|parent case/)
})

test('missing or interrupted TAP remains a failed touched Node check', async t => {
  const f = fixture(t)
  f.write('tests/missing-tap.test.mjs', '')
  const missingRun = (program, args, options) => args.includes('--test')
    ? { status: 1, stdout: 'not TAP output', stderr: '' }
    : f.run(program, args, options)
  const missing = await f.check({ run: missingRun })
  assert.ok(has(missing, 'FAIL', 'tests/missing-tap.test.mjs: unknown tests, unknown failed'))
  const noCounterRun = (program, args, options) => args.includes('--test')
    ? { status: 0, stdout: 'TAP version 13\nok 1 - incomplete counters\n# tests 1\n', stderr: '' }
    : f.run(program, args, options)
  const noCounter = await f.check({ run: noCounterRun })
  assert.ok(has(noCounter, 'FAIL', 'tests/missing-tap.test.mjs: 1 tests, unknown failed'))
  const interruptedRun = (program, args, options) => args.includes('--test')
    ? { status: null, signal: 'SIGTERM', error: new Error('synthetic interruption'), stdout: '', stderr: '' }
    : f.run(program, args, options)
  const interrupted = await f.check({ run: interruptedRun })
  assert.ok(has(interrupted, 'FAIL', safeLine('tests/missing-tap.test.mjs: unknown tests, unknown failed; the runner did not finish')), JSON.stringify(interrupted))
})

test('passing touched Node output keeps its existing message and outcome', async t => {
  const f = fixture(t)
  f.write('tests/passing-output.test.mjs', '')
  const run = (program, args, options) => args.includes('--test')
    ? { status: 0, stdout: 'TAP version 13\nok 1 - a passing case\nnot ok 2 - a planned case # TODO later\n# tests 2\n# fail 0\n', stderr: '' }
    : f.run(program, args, options)
  const checks = await f.check({ run })
  assert.ok(checks.some(item => item.state === 'PASS' && item.message === 'tests/passing-output.test.mjs: 2 tests, 0 failed.'))
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

test('preflight checks the PR body offline and says why when GitHub cannot be reached, never calling that a pass', async t => {
  const f = fixture(t)
  for (const [gh, why] of [[{ version: 0, auth: 1 }, 'not signed in or cannot reach GitHub'], [{ version: null }, 'not installed']]) {
    const calls = []
    const run = (program, args, options) => {
      if (program === 'gh') {
        if (args[0] === '--version') return gh.version === null ? { error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) } : { status: gh.version, stdout: '', stderr: '' }
        return { status: gh.auth, stdout: '', stderr: '' }
      }
      if (args[0] === 'scripts/pr-check.mjs') {
        calls.push(args)
        return args.includes('--offline') ? { status: 0, stdout: 'pr-check: all checks passed\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'pr-check: network check failed for repos/synthetic/issues/1; --offline skips those checks.\n' }
      }
      return f.run(program, args, options)
    }
    const checks = await f.check({ run, bodyFile: 'body.md', title: 'chore: synthetic' })
    assert.ok(has(checks, 'WARN', `because the GitHub CLI is ${why}`), why)
    assert.ok(has(checks, 'PASS', 'PR body passed pr-check without GitHub (--offline)'))
    assert.equal(has(checks, 'PASS', 'PR body passed pr-check.'), false)
    assert.deepEqual(calls.map(args => args.includes('--offline')), [false, true])
  }
})

test('preflight keeps a PR body failure that is not about GitHub, with no offline retry', async t => {
  const f = fixture(t)
  const calls = []
  const run = (program, args, options) => {
    if (program === 'gh') assert.fail('the GitHub CLI is not asked about for a body failure')
    if (args[0] === 'scripts/pr-check.mjs') {
      calls.push(args)
      return { status: 1, stdout: 'FAIL body: the Fixes line is missing\n', stderr: '' }
    }
    return f.run(program, args, options)
  }
  const checks = await f.check({ run, bodyFile: 'body.md', title: 'chore: synthetic' })
  assert.ok(has(checks, 'FAIL', 'PR body: FAIL body: the Fixes line is missing'))
  assert.equal(calls.length, 1)
})

test('preflight asks no CHANGELOG entry for a code change', async t => {
  const f = fixture(t)
  f.write('scripts/new.mjs', 'export const value = 1\n')
  const checks = await f.check()
  assert.ok(has(checks, 'PASS', 'no changelog fragment; the release writes the CHANGELOG line from the pull request title.'))
  assert.equal(checks.some(item => item.state === 'WARN' && /fragment/.test(item.message)), false)
})

test('preflight still checks the test titles of a kept changelog fragment', async t => {
  const f = fixture(t)
  f.write('scripts/synthetic.mjs', 'export const value = 1\n')
  f.write('tests/covering.test.ts', "test('a synthetic fragment has coverage', () => {})\n")
  const path = 'changelog.d/42-synthetic.md'
  f.write(path, '- **A synthetic fragment (#42).** It names its tests.\n  Tests: `a synthetic fragment has coverage`.\n')
  assert.ok(has(await f.check(), 'PASS', 'new CHANGELOG test titles each name exactly one test'))
  f.write(path, '- **A synthetic fragment (#42).** It names its tests.\n  Tests: `an unknown fragment title`.\n')
  assert.ok(has(await f.check(), 'FAIL', 'an unknown fragment title (0 test declarations)'))
})

test('preflight warns of a new changelog fragment, whatever its name, but not of the folder README', async t => {
  const f = fixture(t)
  f.write('scripts/synthetic.mjs', 'export const value = 1\n')
  f.write('changelog.d/README.md', 'Synthetic instructions.\n')
  for (const path of ['changelog.d/42-synthetic.md', 'changelog.d/0042-Bad.md']) f.write(path, '- Synthetic entry (#42). Tests: none (documentation only).\n')
  for (const state of ['untracked', 'staged', 'committed']) {
    if (state === 'staged') f.git('add', '--', 'changelog.d')
    if (state === 'committed') f.commit()
    const checks = await f.check()
    for (const path of ['changelog.d/42-synthetic.md', 'changelog.d/0042-Bad.md']) assert.ok(has(checks, 'WARN', `${path} is a new changelog fragment; a new pull request adds none`), `${state} ${path}`)
    assert.equal(checks.some(item => item.message.startsWith('changelog.d/README.md')), false, state)
  }
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
    const result = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.error, undefined)
    return result
  }
  const passed = run(['--no-fetch'])
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /preflight: \d+ PASS, 1 WARN, 0 FAIL\s*$/)
  assert.ok(passed.stdout.trim().split('\n').slice(0, -1).every(line => /^(PASS|WARN|FAIL) /.test(line)))
  f.write('hooks/board-script.ts', 'changed\n')
  const failed = run(['--no-fetch'])
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /1 FAIL\s*$/)
  assert.equal(run(['--body-file', '/home/private-person/body.md']).status, 1)
  assert.equal(run(['--unknown']).status, 1)
  assert.equal(run(['--lock-platform', 'win32']).status, 1)
  assert.equal(safeLine('C:\\Users\\private-person\\file /home/private-person/file tests/nested/file.mjs\n'), '<path> <path> tests/nested/file.mjs ')
})

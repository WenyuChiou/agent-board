import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GROUPS, checkResults, makePlan, walkDependencies } from '../scripts/ci-impact.mjs'

const groups = [
  'board',
  'messaging',
  'tooling',
  'npm',
  'plugin',
  'installers',
  'remote',
  'journeys',
  'browser',
  'generated',
]

const testFiles = Object.fromEntries(groups.map(group => [group, [`tests/${group}.test.mjs`]]))

const options = (fields = {}) => ({
  deps: Object.fromEntries(groups.map(group => [group, new Set()])),
  tests: structuredClone(testFiles),
  bundleSources: new Set(),
  ...fields,
})

const selected = plan => groups.filter(group => plan.checks[group])

const assertOnly = (plan, expected) => {
  assert.equal(plan.version, 1)
  assert.deepEqual(Object.keys(plan.checks).sort(), [...groups].sort())
  assert.deepEqual(selected(plan), expected)
}

const resultsFor = (plan, selectedStatus = 'success') => Object.fromEntries(
  groups.map(group => [group, plan.checks[group] ? selectedStatus : 'skipped']),
)

test('ci impact exports the stable check groups and permits an empty valid diff', () => {
  assert.deepEqual(GROUPS, groups)
  const plan = makePlan([], options())
  assert.equal(plan.full, false)
  assertOnly(plan, [])
  assert.deepEqual(plan.installerMatrix, [])
  assert.equal(plan.generated.bundle, false)
  assert.equal(plan.generated.released, false)
})

test('ci impact selects isolated runtime groups from known paths', () => {
  const cases = [
    ['scripts/remote-reporter/reporter.py', ['remote']],
    ['bin/agent-board.mjs', ['npm']],
    ['scripts/pr-check.mjs', ['tooling']],
    ['scripts/preflight.mjs', ['tooling']],
    ['scripts/fail-first.mjs', ['tooling']],
    ['scripts/changelog-fold.mjs', ['tooling']],
    ['scripts/team-stats.mjs', ['tooling']],
    ['scripts/review-queue.mjs', ['tooling']],
    ['scripts/review-queue-post.mjs', ['tooling']],
    ['scripts/code-rules.mjs', ['tooling']],
    ['scripts/code-rules.json', ['tooling']],
    ['tests/code-rules.test.mjs', ['tooling']],
    ['scripts/ci-sampler.ps1', ['tooling']],
    ['tests/ci-sampler.test.mjs', ['tooling']],
    ['tests/pr-check.test.mjs', ['tooling']],
    ['tests/preflight.test.mjs', ['tooling']],
    ['tests/fail-first.test.mjs', ['tooling']],
    ['tests/changelog-fold.test.mjs', ['tooling']],
    ['tests/team-stats.test.mjs', ['tooling']],
    ['tests/review-queue.test.mjs', ['tooling']],
    ['tests/review-queue-post.test.mjs', ['tooling']],
    ['scripts/pr-check-rerun.mjs', ['tooling']],
    ['tests/pr-check-rerun.test.mjs', ['tooling']],
  ]
  for (const [path, expected] of cases) assertOnly(makePlan([path], options()), expected)
})

test('ci impact selects only the installer runner needed by the changed installer path', () => {
  for (const [path, runner] of [
    ['scripts/setup.ps1', 'windows-latest'],
    ['tests/setup.check.ps1', 'windows-latest'],
    ['scripts/setup.sh', 'ubuntu-latest'],
    ['tests/setup.check.sh', 'ubuntu-latest'],
  ]) {
    const plan = makePlan([path], options())
    assertOnly(plan, ['installers'])
    assert.deepEqual(plan.installerMatrix, [runner])
  }
})

test('a change to the plugin test runner selects the plugin job on both systems; its own test stays in board', () => {
  const plan = makePlan(['scripts/plugin-tests.mjs'], options())
  assertOnly(plan, ['plugin'])
  assert.deepEqual(plan.pluginMatrix, bothSystems)
  assertOnly(makePlan(['tests/plugin-tests.test.mjs'], options()), ['board'])
})

test('ci impact uses injected dependency sets for ordinary runtime sources', () => {
  const configured = options()
  configured.deps.plugin.add('hooks/pane.tsx')
  assertOnly(makePlan(['hooks/pane.tsx'], configured), ['plugin'])
})

test('ci impact treats ordinary prose and documentation images as non-runtime changes', () => {
  for (const path of ['README.md', 'CHANGELOG.md', 'docs/SETUP.md', 'docs/images/tour-en.svg']) {
    assertOnly(makePlan([path], options()), [])
  }
})

test('ci impact forces every group for planner governance and package manifests', () => {
  for (const path of [
    '.github/workflows/test.yml',
    'scripts/ci-impact.mjs',
    'package.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
  ]) {
    const plan = makePlan([path], options())
    assert.equal(plan.full, true)
    assertOnly(plan, groups)
  }
})

test('ci impact forceFull selects every group independently of changed paths', () => {
  const plan = makePlan([], options({ forceFull: true }))
  assert.equal(plan.full, true)
  assertOnly(plan, groups)
})

test('ci impact bridges bundle sources to each injected consumer and requests regeneration', () => {
  const configured = options({ bundleSources: new Set(['hooks/shared.ts']) })
  for (const group of ['board', 'messaging', 'npm', 'journeys', 'browser']) {
    configured.deps[group].add('hooks/shared.ts')
  }
  const plan = makePlan(['hooks/shared.ts'], configured)
  assertOnly(plan, ['board', 'messaging', 'npm', 'journeys', 'browser', 'generated'])
  assert.equal(plan.generated.bundle, true)
  assert.equal(plan.generated.released, false)
})

test('ci impact does not select browser for a bundle source outside browser dependencies', () => {
  const configured = options({ bundleSources: new Set(['hooks/shared.ts']) })
  for (const group of ['board', 'messaging', 'npm', 'journeys']) configured.deps[group].add('hooks/shared.ts')
  const plan = makePlan(['hooks/shared.ts'], configured)
  assertOnly(plan, ['board', 'messaging', 'npm', 'journeys', 'generated'])
  assert.equal(plan.generated.bundle, true)
})

test('ci impact routes changed and new test files without losing their exact paths', () => {
  const known = makePlan(['tests/board.test.mjs'], options())
  assertOnly(known, ['board'])
  assert.ok(known.testFiles.board.includes('tests/board.test.mjs'))

  const added = makePlan(['tests/new.test.mjs'], options())
  assertOnly(added, ['board'])
  assert.ok(added.testFiles.board.includes('tests/new.test.mjs'))

  assertOnly(makePlan(['tests/ci-impact.test.mjs'], options()), [])
})

test('ci impact unions independent known changes', () => {
  const configured = options()
  configured.deps.plugin.add('hooks/pane.tsx')
  const plan = makePlan(['hooks/pane.tsx', 'bin/agent-board.mjs', 'scripts/setup.sh'], configured)
  assertOnly(plan, ['npm', 'plugin', 'installers'])
  assert.deepEqual(plan.installerMatrix, ['ubuntu-latest'])
})

test('ci impact runs no product check for a change to the review bot settings in greptile.json', () => {
  const plan = makePlan(['greptile.json'], options())
  assert.equal(plan.full, false)
  assertOnly(plan, [])
})

test('ci impact falls back to a full plan for an unknown changed path', () => {
  const plan = makePlan(['new-runtime-root/feature.mjs'], options())
  assert.equal(plan.full, true)
  assertOnly(plan, groups)
})

test('ci impact rejects unsafe or ambiguous changed paths', () => {
  for (const path of ['../outside.mjs', '/absolute.mjs', 'C:\\outside.mjs', 'bad\0name.mjs']) {
    assert.throws(() => makePlan([path], options()))
  }
})

test('ci result validation requires literal success for every selected group', () => {
  const plan = makePlan(['bin/agent-board.mjs'], options())
  assert.deepEqual(checkResults(plan, resultsFor(plan)), { ok: true, errors: [] })
  for (const status of ['skipped', 'neutral', 'cancelled', 'failure']) {
    const result = checkResults(plan, resultsFor(plan, status))
    assert.equal(result.ok, false, status)
    assert.ok(result.errors.length > 0, status)
  }
})

test('ci result validation fails closed on missing group metadata', () => {
  const plan = makePlan(['bin/agent-board.mjs'], options())
  const results = resultsFor(plan)
  delete results.npm
  const result = checkResults(plan, results)
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
})

test('ci result validation never hides failures or cancellations in unselected groups', () => {
  const plan = makePlan([], options())
  for (const status of ['failure', 'cancelled']) {
    const results = resultsFor(plan)
    results.remote = status
    const result = checkResults(plan, results)
    assert.equal(result.ok, false, status)
    assert.ok(result.errors.length > 0, status)
  }
})

test('ci result validation checks unknown reported groups when the plan is full', () => {
  const plan = makePlan([], options({ forceFull: true }))
  const successful = { ...resultsFor(plan), future: 'success' }
  assert.deepEqual(checkResults(plan, successful), { ok: true, errors: [] })
  for (const status of ['failure', 'cancelled', 'skipped']) {
    const result = checkResults(plan, { ...successful, future: status })
    assert.equal(result.ok, false, status)
    assert.ok(result.errors.length > 0, status)
  }
})

const writeFixture = async (root, path, source = '') => {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, source)
}

const withFixture = async callback => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'agent-board-ci-impact-'))
  try {
    await callback(root)
  } finally {
    const resolved = await realpath(root)
    const child = relative(base, resolved)
    assert.equal(isAbsolute(child), false)
    assert.equal(child.startsWith(`..${sep}`) || child === '..', false)
    assert.ok(child.startsWith('agent-board-ci-impact-'))
    await rm(resolved, { recursive: true, force: true })
  }
}

test('dependency walking follows static exports, literal dynamic imports, and file URLs through cycles', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'src/entry.mjs', [
      "import './static.mjs'",
      "export { value } from './reexport.mjs'",
      "await import('./dynamic.mjs')",
      "const asset = new URL('./asset.txt', import.meta.url)",
      "import type { Ignored } from './types.ts'",
      "import 'node:path'",
      "import 'external-package'",
    ].join('\n'))
    await writeFixture(root, 'src/static.mjs', "import './cycle.mjs'")
    await writeFixture(root, 'src/cycle.mjs', "import './static.mjs'")
    await writeFixture(root, 'src/reexport.mjs', 'export const value = 1')
    await writeFixture(root, 'src/dynamic.mjs', 'export const dynamic = true')
    await writeFixture(root, 'src/asset.txt', 'asset')
    await writeFixture(root, 'src/types.ts', 'export type Ignored = string')

    const dependencies = await walkDependencies(root, ['src/entry.mjs'])
    assert.deepEqual([...dependencies].sort(), [
      'src/asset.txt',
      'src/cycle.mjs',
      'src/dynamic.mjs',
      'src/entry.mjs',
      'src/reexport.mjs',
      'src/static.mjs',
    ])
  })
})

test('dependency walking records missing literal files without throwing', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'entry.mjs', "import './missing.mjs'")
    const dependencies = await walkDependencies(root, ['entry.mjs'])
    assert.deepEqual([...dependencies].sort(), ['entry.mjs', 'missing.mjs'])
  })
})

test('dependency walking follows the generated board bundle to its parts without parsing the parts', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'scripts/entry.mjs', "import '../hooks/board-script.ts'")
    await writeFixture(root, 'hooks/board-script.ts', "import { LINES as PART_1 } from './board-script-1.ts'\nexport const BOARD_SCRIPT = [...PART_1].join('\\n')")
    await writeFixture(root, 'hooks/board-script-1.ts', "import './generated-internal.ts'\nexport const LINES = []")
    await writeFixture(root, 'hooks/generated-internal.ts', 'export const internal = true')
    const dependencies = await walkDependencies(root, ['scripts/entry.mjs'])
    assert.deepEqual([...dependencies].sort(), ['hooks/board-script-1.ts', 'hooks/board-script.ts', 'scripts/entry.mjs'])
  })
})

test('a change to one board bundle part alone counts as a bundle change and selects the npm, installer and browser checks', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  assert.equal(makePlan(['hooks/board-script-1.ts'], options()).generated.bundle, true)
  await withFixture(async root => {
    await writeFixture(root, 'hooks/board-script.ts', "import { LINES as PART_1 } from './board-script-1.ts'\nexport const BOARD_SCRIPT = [...PART_1].join('\\n')")
    await writeFixture(root, 'hooks/board-script-1.ts', 'export const LINES = []')
    const plan = await buildPlan(['hooks/board-script-1.ts'], { roots: [root] })
    assert.equal(plan.full, false)
    assert.equal(plan.generated.bundle, true)
    // The browser journeys install this bundle in a child process: a page change runs them (#942).
    assertOnly(plan, ['npm', 'installers', 'browser', 'generated'])
    // setup-agent.mjs runs setup-codex.mjs in a child process too, so a change to it alone runs them as well.
    await writeFixture(root, 'scripts/setup-codex.mjs', 'export {}')
    assert.equal((await buildPlan(['scripts/setup-codex.mjs'], { roots: [root] })).checks.browser, true)
  })
})

test('dependency walking does not expand directories named by file URLs', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'entry.mjs', "const folder = new URL('./fixtures/', import.meta.url)")
    await writeFixture(root, 'fixtures/hidden.mjs', 'export const hidden = true')
    const dependencies = await walkDependencies(root, ['entry.mjs'])
    assert.deepEqual([...dependencies], ['entry.mjs'])
  })
})

test('dependency walking rejects imports that escape the repository root', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'entry.mjs', "import '../outside.mjs'")
    await assert.rejects(() => walkDependencies(root, ['entry.mjs']))
  })
})

test('dependency walking does not follow a directory symlink outside the repository root', async t => {
  await withFixture(async root => {
    const outside = await mkdtemp(join(await realpath(tmpdir()), 'agent-board-ci-impact-outside-'))
    try {
      await writeFixture(outside, 'secret.mjs', 'export const secret = true')
      try {
        await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
          t.skip(`symlinks unavailable: ${error.code}`)
          return
        }
        throw error
      }
      await writeFixture(root, 'entry.mjs', "import './linked/secret.mjs'")
      await assert.rejects(() => walkDependencies(root, ['entry.mjs']))
    } finally {
      const base = await realpath(tmpdir())
      const resolved = await realpath(outside)
      const child = relative(base, resolved)
      assert.equal(isAbsolute(child), false)
      assert.equal(child.startsWith(`..${sep}`) || child === '..', false)
      assert.ok(child.startsWith('agent-board-ci-impact-outside-'))
      await rm(resolved, { recursive: true, force: true })
    }
  })
})

test('generated verification must actually run when bundle sources change', () => {
  const plan = makePlan(['scripts/build-board.ts'], options())
  assert.equal(plan.checks.generated, true)
  assert.equal(checkResults(plan, { ...resultsFor(plan), generated: 'skipped' }).ok, false)
})

test('dependency walking ignores a file URL naming the repository root', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'src/entry.mjs', "const root = new URL('../', import.meta.url)")
    assert.deepEqual([...await walkDependencies(root, ['src/entry.mjs'])], ['src/entry.mjs'])
  })
})

test('base and head dependency unions retain a removed import edge', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async base => withFixture(async head => {
    await writeFixture(base, 'tests/board.test.mjs', "import '../hooks/old.ts'")
    await writeFixture(base, 'hooks/old.ts', 'export const old = true')
    await writeFixture(head, 'tests/board.test.mjs', 'export const current = true')
    const plan = await buildPlan(['hooks/old.ts'], { roots: [base, head] })
    assert.equal(plan.full, false)
    assert.equal(plan.checks.board, true)
    assert.deepEqual(plan.testFiles.board, ['tests/board.test.mjs'])
  }))
})

test('a new standalone test is included even before its name appears in the workflow', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async root => {
    await writeFixture(root, 'tests/new-product.test.mjs', 'export const present = true')
    const plan = await buildPlan(['tests/new-product.test.mjs'], { roots: [root] })
    assert.equal(plan.full, false)
    assert.deepEqual(plan.testFiles.board, ['tests/new-product.test.mjs'])
  })
})

test('test-only CI selection stays narrow beside a changelog fragment', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async root => {
    await writeFixture(root, 'tests/changed.test.mjs', 'export const changed = true')
    await writeFixture(root, 'tests/unrelated.test.mjs', 'export const unrelated = true')
    const fragment = 'changelog.d/339-test-fragment-selection.md'
    const plan = await buildPlan(['tests/changed.test.mjs', fragment], { roots: [root] })
    assert.equal(plan.full, false)
    assertOnly(plan, ['board'])
    assert.deepEqual(plan.testFiles.board, ['tests/changed.test.mjs'])
    const notes = await buildPlan([fragment], { roots: [root] })
    assertOnly(notes, [])
  })
})

test('a changelog fragment does not hide removal of the only affected test', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async base => withFixture(async head => {
    await writeFixture(base, 'tests/deleted.test.mjs', 'export const deleted = true')
    await writeFixture(base, 'tests/remaining.test.mjs', 'export const remaining = true')
    await writeFixture(head, 'tests/remaining.test.mjs', 'export const remaining = true')
    const plan = await buildPlan(['tests/deleted.test.mjs', 'changelog.d/339-test-fragment-selection.md'], { roots: [base, head] })
    assert.equal(plan.full, true)
    assert.ok(plan.notes.some(note => note.includes('removed test')))
    assert.deepEqual(plan.testFiles.board, ['tests/remaining.test.mjs'])
  }))
})

test('runtime and unknown changes keep conservative CI selection beside a changelog fragment', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async root => {
    await writeFixture(root, 'tests/changed.test.mjs', "import '../hooks/runtime.ts'")
    await writeFixture(root, 'tests/unrelated.test.mjs', 'export const unrelated = true')
    await writeFixture(root, 'hooks/runtime.ts', 'export const runtime = true')
    const fragment = 'changelog.d/339-test-fragment-selection.md'
    const runtime = await buildPlan(['hooks/runtime.ts', 'tests/changed.test.mjs', fragment], { roots: [root] })
    assert.equal(runtime.full, false)
    assert.deepEqual(runtime.testFiles.board, ['tests/changed.test.mjs', 'tests/unrelated.test.mjs'])
    const unknown = await buildPlan(['unknown-input.dat', 'tests/changed.test.mjs', fragment], { roots: [root] })
    assert.equal(unknown.full, true)
    assert.ok(Object.values(unknown.checks).every(Boolean))
  })
})

test('removing the only affected test forces a complete plan rather than a zero-test pass', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async base => withFixture(async head => {
    await writeFixture(base, 'tests/board.test.mjs', 'export const before = true')
    const plan = await buildPlan(['tests/board.test.mjs'], { roots: [base, head] })
    assert.equal(plan.full, true)
    assert.ok(plan.notes.some(note => note.includes('removed test')))
  }))
})

test('selected test execution refuses an empty or invalid file list', async () => {
  const { runTestFiles } = await import('../scripts/ci-impact.mjs')
  assert.throws(() => runTestFiles([]))
  assert.throws(() => runTestFiles(['../outside.test.mjs']))
  assert.throws(() => runTestFiles(['tests/missing.test.mjs']))
})

test('a test part runs its share of the files in one Node run, and a bad part is refused before any test runs', async () => {
  const { testArgs, testRuns, runTestFiles } = await import('../scripts/ci-impact.mjs')
  const files = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']
  assert.deepEqual(testArgs(files), ['--test', ...files])
  assert.deepEqual(testArgs(files, { isSerial: true }), ['--test', '--test-concurrency=1', ...files])
  assert.deepEqual(testRuns(files, { part: '1/2' }), [['--test', 'tests/a.test.mjs', 'tests/c.test.mjs']])
  assert.deepEqual(testRuns(files, { part: '2/2' }), [['--test', 'tests/b.test.mjs']])
  assert.deepEqual(testRuns(['tests/a.test.mjs'], { part: '2/2' }), [])
  for (const part of ['0/2', '3/2', '1/0', 'x', '1/2 --inspect']) assert.throws(() => testRuns(files, { part }), /test part/, part)
  assert.throws(() => runTestFiles(['tests/ci-impact.test.mjs'], '3/2'), /test part/)
})

test('a Windows job runs at most two test files at once, and a serial job still one', async () => {
  const { testArgs, testRuns, runTestFiles } = await import('../scripts/ci-impact.mjs')
  const files = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']
  assert.deepEqual(testArgs(files, { isWindows: true }), ['--test', '--test-concurrency=2', ...files])
  assert.deepEqual(testArgs(files, { isWindows: true, isSerial: true }), ['--test', '--test-concurrency=1', ...files])
  assert.deepEqual(testRuns(files, { isWindows: true, part: '2/2' }), [['--test', '--test-concurrency=2', 'tests/b.test.mjs']])
  const serial = process.env.CI_TEST_SERIAL
  delete process.env.CI_TEST_SERIAL
  try {
    const seen = platform => {
      const runs = []
      runTestFiles(['tests/ci-impact.test.mjs'], '', (command, args) => { runs.push(args); return { status: 0 } }, platform)
      return runs
    }
    assert.deepEqual(seen('win32'), [['--test', '--test-concurrency=2', 'tests/ci-impact.test.mjs']])
    assert.deepEqual(seen('linux'), [['--test', 'tests/ci-impact.test.mjs']])
  } finally {
    if (serial === undefined) delete process.env.CI_TEST_SERIAL
    else process.env.CI_TEST_SERIAL = serial
  }
})

test('the summary command writes the recorded run time and its share of the job limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-board-summary-'))
  try {
    const script = fileURLToPath(new URL('../scripts/ci-impact.mjs', import.meta.url))
    const timings = join(dir, 'timings.json'), summary = join(dir, 'summary.md')
    const run = (...args) => spawnSync(process.execPath, [script, 'summary', ...args], { encoding: 'utf8', env: { ...process.env, CI_TEST_TIMINGS: timings, GITHUB_STEP_SUMMARY: summary } })
    await writeFile(timings, JSON.stringify({ version: 1, part: '2/2', serial: false, totalMs: 312_000, files: [] }))
    const ok = run('600')
    assert.equal(ok.status, 0)
    assert.equal(await readFile(summary, 'utf8'), '- part 2/2: tests ran 312s, 52% of the 600s job limit\n')
    assert.notEqual(run().status, 0)
    await rm(timings)
    assert.match(run('600').stdout, /no test timings recorded/)
    // A half-written or odd timings file warns and leaves the job green (#1445).
    for (const text of ['{"version":1,"totalMs":31', '{}', 'null', '{"totalMs":null}', '{"totalMs":{"toString":null}}', '{"totalMs":\n::error::x']) {
      await writeFile(timings, text)
      const bad = run('600')
      assert.equal(bad.status, 0, text)
      assert.match(bad.stdout, /^::warning::/m, text)
      // The warning stays one line, so text from the file never starts a runner command of its own.
      assert.doesNotMatch(bad.stdout, /^::error::/m, text)
    }
    assert.equal(await readFile(summary, 'utf8'), '- part 2/2: tests ran 312s, 52% of the 600s job limit\n')
    // An odd part name reads as the whole run, and a summary file that cannot be written warns.
    await writeFile(timings, JSON.stringify({ totalMs: 60_000, part: { toString: null } }))
    assert.match(run('600').stdout, /^part 1\/1: tests ran 60s, 10% of the 600s job limit$/m)
    const unwritable = spawnSync(process.execPath, [script, 'summary', '600'], { encoding: 'utf8', env: { ...process.env, CI_TEST_TIMINGS: timings, GITHUB_STEP_SUMMARY: dir } })
    assert.equal(unwritable.status, 0)
    assert.match(unwritable.stdout, /^::warning::no summary line: /m)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The self-parted tests are dealt by the table of measured times (#1762): tests/ci-test-times.json.
const readTimes = async () => JSON.parse(await readFile(new URL('./ci-test-times.json', import.meta.url), 'utf8'))
// The tests of a self-parted file in the order the table keeps them, as the test file calls them: a key such as "title #2"
// is the second call with "title".
const callsOf = table => Object.fromEntries(Object.entries(table.tests).map(([file, own]) => [file, Object.keys(own).map(key => key.replace(/ #\d+$/, ''))]))
const boardTestFiles = async () => {
  const { groupForTest } = await import('../scripts/ci-impact.mjs')
  const all = (await readdir(new URL('../tests', import.meta.url), { recursive: true })).map(path => 'tests/' + path.split(sep).join('/')).filter(path => path.endsWith('.test.mjs'))
  return all.filter(path => groupForTest(path) === 'board').sort()
}
// The number of parts of the Windows board job: the largest part total of a Windows entry in either board_matrix list.
const windowsBoardParts = async () => {
  const line = (await workflow()).split('\n').find(text => /^\s*board_matrix:/.test(text))
  assert.ok(line, 'no board_matrix line in test.yml')
  const lists = [...line.matchAll(/'(\[[^']*\])'/g)].map(match => JSON.parse(match[1]))
  assert.equal(lists.length, 2, 'board_matrix should hold a pull request list and a main list')
  const totals = lists.flat().filter(entry => entry.os === 'windows-latest').map(entry => Number(entry.part.split('/')[1]))
  assert.ok(totals.length && totals.every(total => Number.isInteger(total) && total > 0), 'no Windows board part in board_matrix')
  return Math.max(...totals)
}

test('a self-parted test file runs whole in every part and keeps its share, so the parts together run each of its tests once', async () => {
  const { testRuns, partTest, selfPartedTests, partFiles } = await import('../scripts/ci-impact.mjs')
  const files = ['tests/a.test.mjs', 'tests/board.test.mjs', 'tests/b.test.mjs', 'tests/codex-local.test.mjs']
  assert.deepEqual(testRuns(files), [['--test', ...files]])
  assert.deepEqual(testRuns(files, { part: '1/1' }), [['--test', ...files]])
  assert.deepEqual(testRuns(['tests/board.test.mjs'], { isSerial: true, part: '1/2' }), [['--test', '--test-concurrency=1', 'tests/board.test.mjs']])
  // Every part runs both self-parted files whole, and the two other files go out once between the parts.
  const shares = [1, 2].map(index => partFiles(files, index + '/2'))
  for (const share of shares) for (const path of ['tests/board.test.mjs', 'tests/codex-local.test.mjs']) assert.ok(share.includes(path), share.join(' '))
  assert.deepEqual(shares.flat().filter(path => !selfPartedTests.includes(path)).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs'])
  // The deal of tests: slowest first, each to the part with the least so far, ties to the lower part.
  const times = { files: {}, tests: { 'tests/board.test.mjs': { t0: 50, t1: 40, t2: 30, t3: 20, t4: 10 } } }
  const ran = part => {
    const names = []
    const test = partTest(name => names.push(name), part, 'tests/board.test.mjs', times)
    for (const name of ['t0', 't1', 't2', 't3', 't4']) test(name)
    return names
  }
  assert.deepEqual(ran(''), ['t0', 't1', 't2', 't3', 't4'])
  assert.deepEqual(ran('1/1'), ['t0', 't1', 't2', 't3', 't4'])
  assert.deepEqual(ran('1/2'), ['t0', 't3', 't4'])
  assert.deepEqual(ran('2/2'), ['t1', 't2'])
  assert.deepEqual([...ran('1/3'), ...ran('2/3'), ...ran('3/3')].sort(), ['t0', 't1', 't2', 't3', 't4'])
  assert.throws(() => partTest(() => {}, '2/1'), /test part/)
  for (const path of selfPartedTests) assert.match(await readFile(path, 'utf8'), /^const test = partTest\(nodeTest\)$/m, path)
})

test('the parts together run each test of each self-parted file once, whether or not the table knows its title', async () => {
  const table = await readTimes()
  const calls = callsOf(table)
  const { selfPartedTests } = await import('../scripts/ci-impact.mjs')
  assert.deepEqual(Object.keys(calls).sort(), [...selfPartedTests].sort())
  for (const total of [2, 3, 7, 10]) for (const file of selfPartedTests) {
    // The table's tests, a repeated title called twice, and two tests the table has never seen.
    const titles = [...calls[file], 'a new test the table has not seen', calls[file][0], 'another new test, with #2 in it']
    const ran = new Map()
    const { partTest } = await import('../scripts/ci-impact.mjs')
    for (let index = 1; index <= total; index++) {
      const test = partTest((title, number) => ran.set(number, [...(ran.get(number) ?? []), index]), index + '/' + total, file)
      titles.forEach((title, number) => test(title, number))
    }
    assert.equal(ran.size, titles.length, file + ' in ' + total + ' parts')
    for (const [number, parts] of ran) assert.equal(parts.length, 1, file + ' in ' + total + ' parts: test ' + number + ' (' + titles[number] + ') ran in parts ' + parts.join(' '))
  }
})

test('adding a test to a self-parted file moves none of its other tests to another part', async () => {
  const table = await readTimes()
  const calls = callsOf(table)
  const { partTest } = await import('../scripts/ci-impact.mjs')
  const placed = (file, titles, total) => {
    const where = new Map()
    for (let index = 1; index <= total; index++) {
      const test = partTest((title, number) => where.set(number, index), index + '/' + total, file)
      titles.forEach((title, number) => test(title, number))
    }
    return where
  }
  for (const total of [7, 10]) for (const file of Object.keys(calls)) {
    const titles = calls[file]
    const before = placed(file, titles, total)
    for (const at of [0, Math.floor(titles.length / 2), titles.length]) {
      const added = [...titles.slice(0, at), 'a test added since the table was made', ...titles.slice(at)]
      const after = placed(file, added, total)
      titles.forEach((title, number) => assert.equal(after.get(number < at ? number : number + 1), before.get(number), file + ' in ' + total + ' parts: "' + title + '" moved when a test was added at ' + at))
    }
  }
})

test('the parts of a job take the same time of self-parted tests, within 5%, at seven and at ten parts (#1762)', async () => {
  const { partLoads } = await import('../scripts/ci-impact.mjs')
  const files = await boardTestFiles()
  for (const total of [7, 10]) {
    const { shares } = partLoads(files, total)
    assert.equal(shares.length, total)
    assert.ok(Math.max(...shares) <= Math.min(...shares) * 1.05, total + ' parts, seconds of self-parted tests: ' + shares.map(ms => Math.round(ms / 1000)).join(' '))
  }
  // The local exchange job has the messaging tests alone, in three parts on Windows.
  const { shares } = partLoads(['tests/exchange.test.mjs', 'tests/messaging.test.mjs'], 3)
  assert.ok(Math.max(...shares) <= Math.min(...shares) * 1.05, 'messaging, seconds in each of three parts: ' + shares.map(ms => Math.round(ms / 1000)).join(' '))
})

test('the budgeted slow files go to different parts, and the parts together run every other file once', async () => {
  const { partFiles, selfPartedTests, BOARD_FILE_BUDGETS_MS } = await import('../scripts/ci-impact.mjs')
  // The board set in the order main's Windows run 42281474369 listed it, where every-nth put all four budgeted files in part 2 of 6.
  const files = ['answer-guidance', 'board-entry', 'board-json', 'board-status', 'board-storage', 'board-surfaces', 'board', 'classifier-exit-proof', 'codex-fallback', 'codex-host', 'codex-local', 'codex-project-move', 'connect-worker', 'folder-identity', 'host-upgrade', 'legacy-connect', 'local-agent-manifest', 'local-lock', 'mcp-tools', 'messaging-matrix', 'page-look', 'page-regressions', 'page-state', 'page-titles', 'parity', 'performance-budgets', 'preflight-lock-policy', 'prompt-hooks', 'question-clarity', 'readme-codex-trust', 'report-tail', 'report-validation', 'row-keys', 'runtime-folder', 'setup-guidance', 'setup-readme', 'tidy', 'view-index-mutation', 'ws-stdio'].map(name => 'tests/' + name + '.test.mjs')
  const slow = Object.keys(BOARD_FILE_BUDGETS_MS).filter(path => !selfPartedTests.includes(path))
  for (const total of [4, 6, 7]) {
    const shares = Array.from({ length: total }, (_, i) => partFiles(files, (i + 1) + '/' + total))
    // Spread evenly: one per part while there are no more slow files than parts (Windows' 7), else at most one more.
    for (const share of shares) assert.ok(share.filter(path => slow.includes(path)).length <= Math.ceil(slow.length / total), total + ' parts: ' + share.join(' '))
    const others = shares.flat().filter(path => !selfPartedTests.includes(path))
    assert.deepEqual([...others].sort(), files.filter(path => !selfPartedTests.includes(path)).sort())
    for (const share of shares) for (const path of selfPartedTests.filter(one => files.includes(one))) assert.ok(share.includes(path))
  }
})

test('in every number of Windows board parts each part starts from its share of the self-parted tests, and the other files go out once (#1733, #1762)', async () => {
  const { partFiles, partLoads, selfPartedTests } = await import('../scripts/ci-impact.mjs')
  // The board set main's run 44651103054 planned on 5419f63b.
  const files = ['1317-repro', 'accepted-disconnect', 'answer-guidance', 'antigravity-ack', 'antigravity-sidecar', 'approvals', 'background-resume', 'board-dock', 'board-entry', 'board-json', 'board-status', 'board-storage', 'board-surfaces', 'board', 'checkbox-identity', 'classifier-exit-proof', 'codex-done-lifecycle', 'codex-fallback', 'codex-host', 'codex-local', 'codex-project-move', 'codex-resume-guidance', 'connect-worker', 'deepseek-receiver', 'delivery-states', 'folder-identity', 'folder-watchers', 'hook-declarations', 'host-upgrade', 'legacy-connect', 'local-agent-manifest', 'local-lock', 'mcp-tools', 'merge-check', 'messaging-matrix', 'opencode-receiver', 'page-look', 'page-regressions', 'page-state', 'page-titles', 'pane-queued', 'parity', 'path-journeys', 'performance-budgets', 'plugin-tests', 'preflight-lock-policy', 'prompt-hooks', 'question-clarity', 'queued-count', 'readme-codex-trust', 'report-tail', 'report-validation', 'row-keys', 'row-states-surfaces', 'runtime-folder', 'serve-opener', 'serve-watch', 'session-liveness', 'settings-agents', 'settings-symlink', 'setup-board-command', 'setup-guidance', 'setup-readme', 'setup-remove', 'setup-sidecar', 'setup-terminal', 'tidy', 'view-index-mutation', 'ws-stdio'].map(name => 'tests/' + name + '.test.mjs')
  // The split starts every part from a share at any number of parts: with a table of shares for seven only, any other number
  // started every part from zero, and the slowest files went to part 1, which ran 383-520 s of its 480 s (#1733).
  for (const total of [2, 3, 5, 7, 8, 10, 12]) {
    const { shares, loads } = partLoads(files, total)
    assert.ok(shares.every(ms => ms > 0), total + ' parts, shares: ' + shares.join(' '))
    assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.15, total + ' parts, seconds: ' + loads.map(ms => Math.round(ms / 1000)).join(' '))
    const parts = Array.from({ length: total }, (_, i) => partFiles(files, (i + 1) + '/' + total))
    assert.deepEqual(parts.flat().filter(path => !selfPartedTests.includes(path)).sort(), files.filter(path => !selfPartedTests.includes(path)).sort())
  }
})

test('the setup files #1356 added keep their measured weights, so the two slowest are not in one Windows board part (#1757, #1762)', async () => {
  const { partFiles } = await import('../scripts/ci-impact.mjs')
  const table = await readTimes()
  // setup-repair-guidance took 28.2 and 29.9 s in Windows board part 6/7 of main's run 44881995497, which took that part to
  // 491.5 and 498.7 s of its 480 s (#1757); setup-repair-trust 20.8 s locally (19.5 s in the table's run).
  const slow = ['tests/setup-repair-guidance.test.mjs', 'tests/setup-repair-trust.test.mjs']
  for (const path of slow) assert.ok(table.files[path] >= 15_000 && table.files[path] <= 40_000, path + ': ' + table.files[path])
  const files = (await boardTestFiles())
  for (const total of [7, 10]) {
    const parts = Array.from({ length: total }, (_, i) => partFiles(files, (i + 1) + '/' + total))
    assert.equal(parts.filter(part => slow.every(path => part.includes(path))).length, 0, total + ' parts')
  }
})

test('the heaviest Windows board part, on a runner 1.6 times slower than the table, fits its time budget (#1762)', async () => {
  const { partLoads, BOARD_PART_BUDGET_MS } = await import('../scripts/ci-impact.mjs')
  // Windows runners ran the same tests 1.4 to 1.6 times slower from one run to the next, so the load check allows 1.6, and no
  // Windows runner's speed decides it: the table does. A pull request that adds enough test time to cross the line fails
  // here every time, not one run in four on a slow runner.
  const total = await windowsBoardParts()
  const { loads } = partLoads(await boardTestFiles(), total)
  const heaviest = Math.max(...loads)
  const seconds = ms => Math.round(ms / 1000)
  assert.ok(heaviest * 1.6 <= BOARD_PART_BUDGET_MS, 'Windows board part ' + (loads.indexOf(heaviest) + 1) + ' of ' + total + ' is predicted to take ' + seconds(heaviest) + ' s by the table, ' + seconds(heaviest * 1.6) + ' s on a runner 1.6 times slower, over its ' + seconds(BOARD_PART_BUDGET_MS) + ' s budget: add a part or make tests faster. The parts are predicted at ' + loads.map(seconds).join(' ') + ' s.')
})

// Synthetic job logs in the form GitHub Actions prints them: the step's environment, then Node 24's spec lines.
const jobLog = (files, { isSerial = false, lines = [] } = {}) => [
  '  CI_TEST_FILES: ' + JSON.stringify(files),
  '  CI_TEST_PART: 1/2',
  ...(isSerial ? ['  CI_TEST_SERIAL: 1'] : []),
  '##[endgroup]',
  ...lines,
].join('\n')

test('the time table counts a repeated title the same way for every title, constructor and __proto__ included (#1762)', async () => {
  const { readJob, buildTable } = await import('../scripts/ci-test-times.mjs')
  const file = 'tests/board.test.mjs'
  const text = jobLog([file], { isSerial: true, lines: ['✔ constructor (1.5ms)', '✔ __proto__ (2ms)', '✔ constructor (2.5ms)', 'ℹ duration_ms 9'] })
  const items = readJob(text, { name: 'synthetic', partFiles: files => files, selfPartedTests: [file], readSource: () => '' })
  assert.deepEqual(Object.entries(items.tests[file]), [['constructor', 1.5], ['__proto__', 2], ['constructor #2', 2.5]])
  // And the table written from it, as the JSON file holds it, keeps all three with their times.
  const table = JSON.parse(JSON.stringify(buildTable([items])))
  assert.deepEqual(Object.entries(table.tests[file]), [['__proto__', 2], ['constructor', 2], ['constructor #2', 3]])
  assert.equal(table.files[file], 7)
})

test('a test.skip copy of a title counts in partTest as in the time table, so the next copy runs in the part its time gives it (#1762)', async () => {
  const { partTest } = await import('../scripts/ci-impact.mjs')
  const { readJob, buildTable } = await import('../scripts/ci-test-times.mjs')
  const file = 'tests/board.test.mjs'
  const lines = ['✔ the slowest test (1000ms)', '﹣ a repeated title (0.1ms) # SKIP', '✔ a repeated title (10ms)', 'ℹ duration_ms 1100']
  const times = buildTable([readJob(jobLog([file], { isSerial: true, lines }), { name: 'synthetic', partFiles: files => files, selfPartedTests: [file], readSource: () => '' })])
  assert.deepEqual(Object.keys(times.tests[file]), ['a repeated title #2', 'the slowest test'])
  // By the table the slowest test goes to part 1 of 2 and the second copy to part 2; the title alone would hash to part 1.
  const ran = {}
  for (const part of ['1/2', '2/2']) {
    const calls = ran[part] = []
    const record = Object.assign(title => calls.push(title), { skip: title => calls.push('skip: ' + title), only: () => {}, todo: () => {} })
    const run = partTest(record, part, file, times)
    run('the slowest test')
    run.skip('a repeated title')
    run('a repeated title')
  }
  assert.ok(ran['2/2'].includes('a repeated title') && !ran['1/2'].includes('a repeated title'), JSON.stringify(ran))
  assert.equal([...ran['1/2'], ...ran['2/2']].filter(call => call === 'skip: a repeated title').length, 1, JSON.stringify(ran))
})

test('in a run of several files, a test is timed for a self-parted file only when that file\'s source gives it that whole title, written out or built from a template (#1762)', async () => {
  const { readJob } = await import('../scripts/ci-test-times.mjs')
  const sources = {
    'tests/messaging.test.mjs': "import { test } from 'node:test'\ntest('a message reaches its reader', () => {})\nfor (const kind of ['direct', 'queued']) test(`a ${kind} message reaches every reader`, () => {})\n",
    'tests/exchange.test.mjs': "import { test } from 'node:test'\ntest('an exchange keeps its order', () => {})\ntest('a message reaches its reader!', () => {})\n",
  }
  const lines = ['✔ a message reaches its reader (3ms)', '✔ a direct message reaches every reader (5ms)', '✔ an exchange keeps its order (4ms)', '✔ a message reaches its reader! (6ms)', 'ℹ duration_ms 20']
  const items = readJob(jobLog(Object.keys(sources), { lines }), { name: 'synthetic', partFiles: files => files, selfPartedTests: ['tests/messaging.test.mjs'], readSource: file => sources[file] })
  assert.deepEqual({ ...items.tests['tests/messaging.test.mjs'] }, { 'a message reaches its reader': 3, 'a direct message reaches every reader': 5 })
})

test('a log of a run of several files cut off before its summary is refused, so no table is written from it (#1762)', async () => {
  const { readJob } = await import('../scripts/ci-test-times.mjs')
  const text = jobLog(['tests/messaging.test.mjs', 'tests/exchange.test.mjs'], { lines: ['✔ a message reaches its reader (3ms)', '✔ an exchange keeps its order (4ms)'] })
  assert.throws(() => readJob(text, { name: 'cut', partFiles: files => files, selfPartedTests: ['tests/messaging.test.mjs'], readSource: () => "test('a message reaches its reader')" }), /cut: 0 complete test runs in the log/)
})

test('every Windows and Ubuntu board part runs a share of legacy-connect, so no part holds the whole file beside its share of codex-local (#1741)', async () => {
  const { partFiles, selfPartedTests } = await import('../scripts/ci-impact.mjs')
  // Whole, legacy-connect took 101-179 s on Windows; the part that held it ran 483.2-505.0 s of its 480 s on main's
  // runs 44642014114 and 44651103054 (part 1) and 44697238483 (part 4, twice), while the other parts stayed under.
  assert.ok(selfPartedTests.includes('tests/legacy-connect.test.mjs'))
  const files = ['tests/board.test.mjs', 'tests/codex-local.test.mjs', 'tests/host-upgrade.test.mjs', 'tests/legacy-connect.test.mjs', 'tests/prompt-hooks.test.mjs']
  for (const total of [2, 3, 7, 10]) for (let index = 1; index <= total; index++) assert.ok(partFiles(files, index + '/' + total).includes('tests/legacy-connect.test.mjs'), index + '/' + total)
  // And the deal gives each part some of its tests, at any number of parts.
  const { partTest } = await import('../scripts/ci-impact.mjs')
  const titles = Object.keys((await readTimes()).tests['tests/legacy-connect.test.mjs'])
  for (const total of [2, 3, 7, 10]) for (let index = 1; index <= total; index++) {
    let ran = 0
    const run = partTest(() => ran++, index + '/' + total, 'tests/legacy-connect.test.mjs')
    for (const title of titles) run(title)
    assert.ok(ran > 0, 'legacy-connect runs no test in part ' + index + '/' + total)
  }
})

test('the message-store journey gets a Windows journeys part to itself, and the three parts together run every journey once (#1722)', async () => {
  const { partFiles } = await import('../scripts/ci-impact.mjs')
  // The journeys in the order main's Windows run 44615703631 listed them. l3c took 289.1 s of part 2/2's 529 s there.
  const files = ['host-journeys', 'l0-readme', 'l1-first-run', 'l2-working-day', 'l2b-desktop-app', 'l3-across-agents', 'l3b-messaging', 'l3c-message-store-ownership', 'l4-startup-time', 'l4-time', 'l5-faults', 'l7-plain-words', 'latency-observation', 'processes', 'receipt-trace', 'recovery-observation', 'retirement', 'runner', 'soak-args'].map(name => 'tests/e2e/' + name + '.test.mjs')
  const l3c = 'tests/e2e/l3c-message-store-ownership.test.mjs'
  const shares = [1, 2, 3].map(index => partFiles(files, index + '/3'))
  const alone = shares.filter(share => share.includes(l3c))
  assert.deepEqual(alone, [[l3c]], shares.map(share => share.join(' ')).join(' | '))
  const others = shares.filter(share => !share.includes(l3c))
  assert.deepEqual(others.map(share => share.length), [9, 9])
  assert.deepEqual(shares.flat().sort(), [...files].sort())
})

test('the part given to a run reaches its test processes, even when the environment names another part', async () => {
  const { runTestFiles } = await import('../scripts/ci-impact.mjs')
  const saved = process.env.CI_TEST_PART
  process.env.CI_TEST_PART = '2/2'
  try {
    const partsSeen = part => {
      const seen = []
      runTestFiles(['tests/board.test.mjs'], part, (command, args, options) => { seen.push(options.env.CI_TEST_PART); return { status: 0 } })
      return seen
    }
    assert.deepEqual(partsSeen('1/1'), ['1/1'])
    assert.deepEqual(partsSeen(''), [''])
    assert.deepEqual(partsSeen('1/2'), ['1/2'])
    assert.deepEqual(partsSeen(undefined), ['2/2'])
  } finally {
    if (saved === undefined) delete process.env.CI_TEST_PART
    else process.env.CI_TEST_PART = saved
  }
})

test('the board time check fails a file over seventy percent of its budget and a part over its full budget', async () => {
  const { checkBoardTimes, BOARD_FILE_BUDGETS_MS, BOARD_FILE_BUDGET_DEFAULT_MS, BOARD_PART_BUDGET_MS } = await import('../scripts/ci-impact.mjs')
  assert.equal(BOARD_FILE_BUDGETS_MS['tests/board.test.mjs'], 200_000)
  assert.equal(BOARD_FILE_BUDGET_DEFAULT_MS, 60_000)
  assert.equal(BOARD_PART_BUDGET_MS, 480_000)
  const base = { version: 1, part: '1/4', serial: true, totalMs: 300_000, files: [{ path: 'tests/board.test.mjs', ms: 90_000 }, { path: 'tests/ws-stdio.test.mjs', ms: 5_000 }] }
  assert.deepEqual(checkBoardTimes(base), { ok: true, errors: [], warnings: [] })
  // Exactly seventy percent is not over the limit, for both named and default budgets.
  for (const [path, budget] of [...Object.entries(BOARD_FILE_BUDGETS_MS), ['tests/ws-stdio.test.mjs', BOARD_FILE_BUDGET_DEFAULT_MS]]) {
    const limit = budget * 7 / 10
    const atLimit = { ...base, files: [{ path, ms: limit }] }
    assert.deepEqual(checkBoardTimes(atLimit), { ok: true, errors: [], warnings: [] })
    assert.equal(checkBoardTimes({ ...atLimit, files: [{ path, ms: limit + 1 }] }).ok, false)
  }
  // prompt-hooks' slowest Windows run so far, 67.9 s, failed its old 90 s budget (#1603); its new budget passes it.
  assert.deepEqual(checkBoardTimes({ ...base, files: [{ path: 'tests/prompt-hooks.test.mjs', ms: 67_900 }] }), { ok: true, errors: [], warnings: [] })
  // merge-check's slowest Windows run so far, 46.4 s, failed the 60 s default budget (#1464); its own budget passes it.
  assert.deepEqual(checkBoardTimes({ ...base, files: [{ path: 'tests/merge-check.test.mjs', ms: 46_400 }] }), { ok: true, errors: [], warnings: [] })
  // The Windows Node 24 times that failed #1709 with every test green (#1715) pass the files' new budgets.
  for (const [path, ms] of [['tests/approvals.test.mjs', 47_100], ['tests/codex-local.test.mjs', 167_400], ['tests/host-upgrade.test.mjs', 80_600], ['tests/setup-terminal.test.mjs', 73_400]]) {
    assert.deepEqual(checkBoardTimes({ ...base, files: [{ path, ms }] }), { ok: true, errors: [], warnings: [] }, path)
  }
  const slowFile = { ...base, files: [{ path: 'tests/board.test.mjs', ms: 141_000 }] }
  const overFile = checkBoardTimes(slowFile)
  assert.equal(overFile.ok, false)
  assert.deepEqual(overFile.errors, ['tests/board.test.mjs took 141s, over 70% of its 200s budget (140s)'])
  assert.deepEqual(checkBoardTimes(slowFile, { isPullRequest: false }), { ok: true, errors: [], warnings: overFile.errors })
  const overPart = checkBoardTimes({ ...base, totalMs: 500_000, files: [
    { path: 'tests/board.test.mjs', ms: 90_000 },
    { path: 'tests/codex-local.test.mjs', ms: 110_000 },
    { path: 'tests/legacy-connect.test.mjs', ms: 90_000 },
  ] })
  assert.equal(overPart.ok, false)
  assert.deepEqual(overPart.errors, ['board part 1/4 took 500s, over its 480s budget; slowest files: tests/codex-local.test.mjs 110s, tests/board.test.mjs 90s, tests/legacy-connect.test.mjs 90s'])
  assert.deepEqual(checkBoardTimes(null), { ok: false, errors: ['missing or invalid board timings'], warnings: [] })
  // A file outside the board group, and a file with no time recorded, are not judged.
  const unjudged = { ...base, totalMs: 100_000, files: [{ path: 'tests/messaging.test.mjs', ms: 999_000 }, { path: 'tests/board.test.mjs', ms: null }] }
  assert.deepEqual(checkBoardTimes(unjudged), { ok: true, errors: [], warnings: [] })
})

test('setup-sidecar has a budget of its own: the 49.0 s that failed #1680 on Windows Node 24 passes it', async () => {
  const { checkBoardTimes } = await import('../scripts/ci-impact.mjs')
  // #1680 adds eleven removal re-read tests to the file: up to 49.0 s on Windows Node 24 (run 44650276536), over the 42 s
  // line of the 60 s default. 49 049 ms is the slowest time that run could have printed as 49.0 s.
  const timings = { part: '7/7', totalMs: 300_000, files: [{ path: 'tests/setup-sidecar.test.mjs', ms: 49_049 }] }
  assert.deepEqual(checkBoardTimes(timings), { ok: true, errors: [], warnings: [] })
})

test('host-upgrade\'s budget passes the 109.1 s that failed #1730 on Windows Node 24 (#1662)', async () => {
  const { checkBoardTimes } = await import('../scripts/ci-impact.mjs')
  // #1730 adds three Windows tests that start setup from a copied Node: 109.1 s on Windows Node 24 (run 44681768984),
  // over the 105 s line of the 150 s budget. 109 149 ms is the slowest time that run could have printed as 109.1 s.
  const timings = { part: '2/7', totalMs: 448_800, files: [{ path: 'tests/host-upgrade.test.mjs', ms: 109_149 }] }
  assert.deepEqual(checkBoardTimes(timings), { ok: true, errors: [], warnings: [] })
})

test('the time check passes the Windows times that failed pull requests after #1361, and its 70% line is at least 1.3x each file\'s slowest recent run (#1364)', async () => {
  const { checkBoardTimes, BOARD_FILE_BUDGETS_MS, BOARD_FILE_BUDGET_DEFAULT_MS } = await import('../scripts/ci-impact.mjs')
  const budgetOf = path => BOARD_FILE_BUDGETS_MS[path] ?? BOARD_FILE_BUDGET_DEFAULT_MS
  // Times from failed Windows Node 24 board jobs whose tests all passed (runs 43157566128, 43158052807, 43160255649).
  const failedPullRequestTimes = [
    ['tests/legacy-connect.test.mjs', 144_500], ['tests/host-upgrade.test.mjs', 42_700], ['tests/board.test.mjs', 105_500],
    ['tests/codex-fallback.test.mjs', 60_000], ['tests/prompt-hooks.test.mjs', 46_200],
  ]
  for (const [path, ms] of failedPullRequestTimes) {
    assert.deepEqual(checkBoardTimes({ version: 1, part: '1/6', serial: true, totalMs: 300_000, files: [{ path, ms }] }), { ok: true, errors: [], warnings: [] }, path)
  }
  // The slowest Windows Node 24 time of each file in the six test runs after #1361 (#1364's table).
  const slowest = {
    'tests/legacy-connect.test.mjs': 148_000, 'tests/codex-local.test.mjs': 120_400, 'tests/board.test.mjs': 105_500,
    'tests/codex-fallback.test.mjs': 60_000, 'tests/prompt-hooks.test.mjs': 46_200, 'tests/host-upgrade.test.mjs': 42_600,
    'tests/setup-guidance.test.mjs': 52_600, 'tests/setup-terminal.test.mjs': 36_000, 'tests/settings-agents.test.mjs': 21_300,
  }
  // #1339 added lock tests, several of which wait out the 2 s bounded wait: settings-symlink's Windows Node 24 time since (run 43190652904).
  slowest['tests/settings-symlink.test.mjs'] = 43_400
  // #1366's receiver tests run in parts since 164.0 s on Windows Node 24 (run 43644841624): one part's share, estimated
  // from that run's test times (40.6 s at most, with the file's start about 44 s).
  slowest['tests/opencode-receiver.test.mjs'] = 44_000
  // #1302 adds upgrade journeys: host-upgrade's slowest Windows Node 24 run with the first two of them (run 43181075103).
  slowest['tests/host-upgrade.test.mjs'] = 57_600
  // #1715: the slowest Windows Node 24 times on #1709 (runs 44543091708, 44550262085, 44553112605).
  Object.assign(slowest, { 'tests/approvals.test.mjs': 47_100, 'tests/codex-local.test.mjs': 167_400, 'tests/host-upgrade.test.mjs': 80_600, 'tests/setup-terminal.test.mjs': 73_400 })
  // #1680: setup-sidecar's slowest Windows Node 24 time with its eleven removal re-read tests (run 44650276536).
  slowest['tests/setup-sidecar.test.mjs'] = 49_000
  // #1730: host-upgrade's Windows Node 24 time with its three copied-Node setup tests (run 44681768984).
  slowest['tests/host-upgrade.test.mjs'] = 109_100
  for (const [path, ms] of Object.entries(slowest)) assert.ok(budgetOf(path) * 7 / 10 >= ms * 13 / 10, path + ': ' + budgetOf(path))
})

test('the CI time budget command fails an over-seventy-percent file on a pull request and only reports it on main', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-board-budget-'))
  const timings = join(dir, 'timings.json')
  const command = fileURLToPath(new URL('../scripts/ci-impact.mjs', import.meta.url))
  const base = { version: 1, part: '1/4', serial: true, totalMs: 100_000 }
  try {
    for (const [path, under, over] of [['tests/board.test.mjs', 139_000, 141_000], ['tests/ws-stdio.test.mjs', 41_000, 43_000]]) {
      for (const [event, ms, status] of [['pull_request', under, 0], ['pull_request', over, 1], ['push', over, 0]]) {
        await writeFile(timings, JSON.stringify({ ...base, files: [{ path, ms }] }))
        const result = spawnSync(process.execPath, [command, 'check'], {
          env: { ...process.env, CI_TEST_TIMINGS: timings, GITHUB_EVENT_NAME: event },
          encoding: 'utf8',
          timeout: 10_000,
        })
        assert.ifError(result.error)
        assert.equal(result.status, status, result.stdout + result.stderr)
        if (ms === over) {
          assert.match(result.stdout, /over 70% of its/)
          assert.equal(result.stdout.includes('reported only'), event === 'push')
        }
      }
    }
    // The existing part budget still fails on main.
    await writeFile(timings, JSON.stringify({ ...base, totalMs: 480_001, files: [{ path: 'tests/board.test.mjs', ms: 90_000 }] }))
    const part = spawnSync(process.execPath, [command, 'check'], {
      env: { ...process.env, CI_TEST_TIMINGS: timings, GITHUB_EVENT_NAME: 'push' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.ifError(part.error)
    assert.equal(part.status, 1, part.stdout + part.stderr)
    assert.match(part.stdout, /over its 480s budget/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a serial run times one file at a time and records the times for the time check', async () => {
  const { runTestFiles, partFiles } = await import('../scripts/ci-impact.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'agent-board-timings-'))
  const serial = process.env.CI_TEST_SERIAL
  const timings = process.env.CI_TEST_TIMINGS
  process.env.CI_TEST_SERIAL = '1'
  process.env.CI_TEST_TIMINGS = join(dir, 'timings.json')
  try {
    const files = ['tests/ws-stdio.test.mjs', 'tests/connect-worker.test.mjs', 'tests/board.test.mjs']
    const mine = partFiles(files, '1/2')
    assert.ok(mine.length >= 1 && mine.length <= 3)
    assert.ok(mine.includes('tests/board.test.mjs'))
    const calls = []
    runTestFiles(files, '1/2', (command, args) => { calls.push(args); return { status: 0 } }, 'win32')
    assert.deepEqual(calls, mine.map(path => ['--test', '--test-concurrency=1', path]))
    const recorded = JSON.parse(await readFile(process.env.CI_TEST_TIMINGS, 'utf8'))
    assert.equal(recorded.version, 1)
    assert.equal(recorded.part, '1/2')
    assert.equal(recorded.serial, true)
    assert.equal(typeof recorded.totalMs, 'number')
    assert.equal(recorded.files.length, mine.length)
    assert.equal(recorded.files[0].path, mine[0])
    assert.equal(typeof recorded.files[0].ms, 'number')
    // A failing file does not stop the rest, and the times are still recorded.
    const failing = []
    assert.throws(() => runTestFiles(files, '1/2', (command, args) => { failing.push(args); return { status: args.includes('tests/board.test.mjs') ? 1 : 0 } }, 'win32'), /selected tests failed: 1/)
    assert.equal(failing.length, mine.length)
    const recordedAfterFailure = JSON.parse(await readFile(process.env.CI_TEST_TIMINGS, 'utf8'))
    assert.equal(recordedAfterFailure.files.length, mine.length)
  } finally {
    if (serial === undefined) delete process.env.CI_TEST_SERIAL
    else process.env.CI_TEST_SERIAL = serial
    if (timings === undefined) delete process.env.CI_TEST_TIMINGS
    else process.env.CI_TEST_TIMINGS = timings
    await rm(dir, { recursive: true, force: true })
  }
})

test('a parallel run keeps its single Node run and records no per-file times', async () => {
  const { runTestFiles } = await import('../scripts/ci-impact.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'agent-board-timings-'))
  const serial = process.env.CI_TEST_SERIAL
  const timings = process.env.CI_TEST_TIMINGS
  delete process.env.CI_TEST_SERIAL
  process.env.CI_TEST_TIMINGS = join(dir, 'timings.json')
  try {
    const calls = []
    runTestFiles(['tests/ws-stdio.test.mjs', 'tests/connect-worker.test.mjs'], '', (command, args) => { calls.push(args); return { status: 0 } }, 'linux')
    assert.deepEqual(calls, [['--test', 'tests/ws-stdio.test.mjs', 'tests/connect-worker.test.mjs']])
    const recorded = JSON.parse(await readFile(process.env.CI_TEST_TIMINGS, 'utf8'))
    assert.equal(recorded.serial, false)
    assert.deepEqual(recorded.files, [
      { path: 'tests/ws-stdio.test.mjs', ms: null },
      { path: 'tests/connect-worker.test.mjs', ms: null },
    ])
  } finally {
    if (serial === undefined) delete process.env.CI_TEST_SERIAL
    else process.env.CI_TEST_SERIAL = serial
    if (timings === undefined) delete process.env.CI_TEST_TIMINGS
    else process.env.CI_TEST_TIMINGS = timings
    await rm(dir, { recursive: true, force: true })
  }
})

test('the time check command fails on over-budget timings and passes on green ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-board-timings-'))
  try {
    const path = join(dir, 'timings.json')
    const script = fileURLToPath(new URL('../scripts/ci-impact.mjs', import.meta.url))
    const run = () => spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env: { ...process.env, CI_TEST_TIMINGS: path, GITHUB_EVENT_NAME: 'pull_request' } })
    await writeFile(path, JSON.stringify({ version: 1, part: '1/4', serial: true, totalMs: 300_000, files: [{ path: 'tests/board.test.mjs', ms: 90_000 }] }))
    const green = run()
    assert.equal(green.status, 0)
    assert.match(green.stdout, /total 300s of 480s budget/)
    await writeFile(path, JSON.stringify({ version: 1, part: '1/4', serial: true, totalMs: 500_000, files: [
      { path: 'tests/board.test.mjs', ms: 200_000 },
      { path: 'tests/codex-local.test.mjs', ms: 180_000 },
      { path: 'tests/legacy-connect.test.mjs', ms: 100_000 },
    ] }))
    const red = run()
    assert.equal(red.status, 1)
    assert.match(red.stdout, /tests\/board\.test\.mjs took 200s, over 70% of its 200s budget \(140s\)/)
    assert.match(red.stdout, /board part 1\/4 took 500s, over its 480s budget; slowest files: tests\/board\.test\.mjs 200s, tests\/codex-local\.test\.mjs 180s/)
    const missing = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env: { ...process.env, CI_TEST_TIMINGS: join(dir, 'missing.json') } })
    assert.equal(missing.status, 0)
    assert.match(missing.stdout, /no test timings recorded/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ci result validation rejects incomplete or non-boolean selection metadata', () => {
  const plan = makePlan([], options())
  const incomplete = structuredClone(plan)
  delete incomplete.checks.board
  assert.equal(checkResults(incomplete, resultsFor(plan)).ok, false)
  assert.equal(checkResults({ ...plan, full: 'false' }, resultsFor(plan)).ok, false)
})

test('a change the messaging table reads runs the matrix test and no other board test', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async root => {
    await writeFixture(root, 'tests/e2e/l0-readme.test.mjs', 'export const contract = true')
    await writeFixture(root, 'tests/messaging-matrix.test.mjs', 'export const matrix = true')
    await writeFixture(root, 'tests/other.test.mjs', 'export const other = true')
    await writeFixture(root, 'tests/messaging.test.mjs', "import '../scripts/receiver.mjs'\nimport '../hooks/typed.ts'\n")
    await writeFixture(root, 'scripts/receiver.mjs', 'export const messagingReceiver = {}')
    await writeFixture(root, 'hooks/typed.ts', 'export const messagingReceiver: object = {}')
    await writeFixture(root, 'scripts/new-receiver.mjs', 'export const messagingReceiver = {}')
    for (const path of ['README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'docs/MESSAGING.md', 'docs/validation/2026-11-03-codex-live.md', 'scripts/receiver.mjs', 'hooks/typed.ts']) {
      const plan = await buildPlan([path], { roots: [root] })
      assert.equal(plan.checks.board, true, path)
      assert.deepEqual(plan.testFiles.board, ['tests/messaging-matrix.test.mjs'], path)
    }
    // A new record file is still an unclassified path, so its own tests can't be missed.
    assert.equal((await buildPlan(['scripts/new-receiver.mjs'], { roots: [root] })).full, true)
    const other = await buildPlan(['docs/GUIDE.md'], { roots: [root] })
    assert.equal(other.checks.board, false)
    const both = await buildPlan(['README.md', 'tests/other.test.mjs'], { roots: [root] })
    assert.ok(both.testFiles.board.includes('tests/other.test.mjs'))
    assert.ok(both.testFiles.board.includes('tests/messaging-matrix.test.mjs'))
  })
})

test('README-only changes run the README contract rather than every product journey', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async root => {
    await writeFixture(root, 'tests/e2e/l0-readme.test.mjs', 'export const contract = true')
    await writeFixture(root, 'tests/e2e/l4-time.test.mjs', 'export const clock = true')
    const plan = await buildPlan(['README.md'], { roots: [root] })
    assert.deepEqual(plan.testFiles.journeys, ['tests/e2e/l0-readme.test.mjs'])
    assert.deepEqual(selected(plan), ['journeys'])
  })
})

const bothSystems = ['ubuntu-latest', 'windows-latest']

test('a pull request that changes the plugin\'s hooks or bundle runs the plugin check on Windows too', () => {
  // As in the real planner, the plugin's own walk reaches each hooks/ path here (bundle parts included).
  const loaded = path => options({ deps: { ...options().deps, plugin: new Set([path]) }, pluginRuntime: new Set([path]) })
  for (const path of ['hooks/pane.tsx', 'hooks/hooks.json', 'hooks/board-script.ts', 'hooks/board-script-2.ts', '.claude-plugin/plugin.json', 'package.json', '.gitattributes', '.github/workflows/test.yml']) {
    const plan = makePlan([path], loaded(path))
    assert.equal(plan.checks.plugin, true, path)
    assert.deepEqual(plan.pluginMatrix, bothSystems, path)
  }
  // A hooks/ file the plugin does not load selects no plugin check, so it names no Windows row either.
  const unloaded = makePlan(['hooks/board-only-example.ts'], options({ deps: { ...options().deps, board: new Set(['hooks/board-only-example.ts']) } }))
  assert.equal(unloaded.checks.plugin, false)
  assert.deepEqual(unloaded.pluginMatrix, ['ubuntu-latest'])
  // One path in a mixed change is enough, and a file the plugin's own walk reaches counts like a hook.
  assert.deepEqual(makePlan(['README.md', 'hooks/pane.tsx'], loaded('hooks/pane.tsx')).pluginMatrix, bothSystems)
  assert.deepEqual(makePlan(['types/index.d.ts'], loaded('types/index.d.ts')).pluginMatrix, bothSystems)
})

test('a pull request that changes only a plugin test file runs the plugin check on Ubuntu only', () => {
  const plan = makePlan(['tests/pane.test.tsx'], options())
  assert.equal(plan.checks.plugin, true)
  assert.deepEqual(plan.pluginMatrix, ['ubuntu-latest'])
  assert.deepEqual(makePlan(['docs/dev/CI.md'], options()).pluginMatrix, ['ubuntu-latest'])
  assert.equal(makePlan(['docs/dev/CI.md'], options()).checks.plugin, false)
  // A code walk that only reaches the plugin's tests does not make them run-time files.
  assert.deepEqual(makePlan(['tests/fixtures/helper.ts'], options({ deps: { ...options().deps, plugin: new Set(['tests/fixtures/helper.ts']) } })).pluginMatrix, ['ubuntu-latest'])
})

test('the planner writes the plugin systems for the workflow and reads the plugin run-time files from the walk', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const repository = fileURLToPath(new URL('..', import.meta.url))
  await withFixture(async root => {
    const pluginOs = async paths => {
      const output = join(root, 'output-' + paths.length + '-' + paths[0].replaceAll('/', '_'))
      await writeFile(output, '')
      const run = spawnSync(process.execPath, [join(repository, 'scripts/ci-impact.mjs'), 'plan'], {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, CI_SOURCE_ROOTS: JSON.stringify([repository]), CI_CHANGED_FILES: JSON.stringify(paths), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
      })
      assert.equal(run.status, 0, run.stderr)
      return JSON.parse((await readFile(output, 'utf8')).split('\n').find(line => line.startsWith('plugin_os=')).slice('plugin_os='.length))
    }
    assert.deepEqual(await pluginOs(['hooks/pane.tsx']), bothSystems)
    assert.deepEqual(await pluginOs(['types/index.d.ts']), bothSystems)
    assert.deepEqual(await pluginOs(['tests/pane.test.tsx']), ['ubuntu-latest'])
  })
})

const workflow = async () => {
  const { readFile } = await import('node:fs/promises')
  return (await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
}

test('a pull request runs Node 22 on Ubuntu and Node 24 on Windows, and main, the weekly run and a release run every pair', async () => {
  const text = await workflow()
  const two = '[{"os":"ubuntu-latest","node":22},{"os":"windows-latest","node":24}]'
  const four = '[{"os":"ubuntu-latest","node":22},{"os":"ubuntu-latest","node":24},{"os":"windows-latest","node":22},{"os":"windows-latest","node":24}]'
  const onPr = "(github.event_name == 'pull_request' && !startsWith(github.event.pull_request.title, 'chore(release):'))"
  assert.ok(text.includes(`node_matrix: \${{ ${onPr} && '${two}' || '${four}' }}`))
  // On a pull request the planner picks the plugin systems; an empty planner output falls through to both.
  assert.ok(text.includes(`plugin_os: \${{ ${onPr} && steps.plan.outputs.plugin_os || '["ubuntu-latest","windows-latest"]' }}`))
  assert.match(text, /plugin_os:'\["ubuntu-latest","windows-latest"\]'/)
  // The board job and the journeys take the same pairs, with the Windows sets in serial parts so each
  // keeps ten minutes: the board in ten (#1059, #1718, #1762), the journeys in three (#910, #1722). The Ubuntu board set runs in three
  // parts, since a part lasts about as long as its share of codex-local (#1130, #1764).
  const parts = (node, n, os = 'windows-latest') => Array.from({ length: n }, (_, i) => `{"os":"${os}","node":${node},"part":"${i + 1}/${n}"}`).join(',')
  const ubuntu = '{"os":"ubuntu-latest","node":22,"part":"1/1"}', ubuntu24 = '{"os":"ubuntu-latest","node":24,"part":"1/1"}'
  assert.ok(text.includes(`board_matrix: \${{ ${onPr} && '[${parts(22, 3, 'ubuntu-latest')},${parts(24, 10)}]' || '[${parts(22, 3, 'ubuntu-latest')},${parts(24, 3, 'ubuntu-latest')},${parts(22, 10)},${parts(24, 10)}]' }}`))
  assert.ok(text.includes(`journeys_matrix: \${{ ${onPr} && '[${ubuntu},${parts(24, 3)}]' || '[${ubuntu},${ubuntu24},${parts(22, 3)},${parts(24, 3)}]' }}`))
  // The local exchange job runs in two parts on Ubuntu and three on Windows: with the Codex delivery tests the whole
  // Ubuntu run took 92-94% of ten minutes and each Windows part of two up to 67% on main (#1445).
  assert.ok(text.includes(`messaging_matrix: \${{ ${onPr} && '[${parts(22, 2, 'ubuntu-latest')},${parts(24, 3)}]' || '[${parts(22, 2, 'ubuntu-latest')},${parts(24, 2, 'ubuntu-latest')},${parts(22, 3)},${parts(24, 3)}]' }}`))
  for (const group of ['board', 'messaging', 'tooling', 'npm', 'journeys']) {
    const block = text.split('\n  ' + group + ':\n')[1]?.split(/\n  [\w-]+:\n/)[0]
    assert.ok(block, group)
    const matrix = group === 'board' || group === 'journeys' || group === 'messaging' ? `${group}_matrix` : 'node_matrix'
    assert.ok(block.includes(`include: \${{ fromJSON(needs.impact.outputs.${matrix}) }}`), group)
    if (group === 'board' || group === 'journeys' || group === 'messaging') {
      // A Windows board job has two more minutes, one for each of the sampler's two steps (#1249).
      const minutes = group === 'board' ? "timeout-minutes: ${{ matrix.os == 'windows-latest' && 12 || 10 }}" : 'timeout-minutes: 10'
      assert.ok(block.includes('CI_TEST_PART: ${{ matrix.part }}') && block.includes(minutes), group)
    }
    if (group === 'board' || group === 'journeys') {
      assert.ok(block.includes("CI_TEST_SERIAL: ${{ runner.os == 'Windows' && '1' || '' }}"), group)
    }
    if (group === 'messaging') {
      assert.ok(block.includes("format(', part {0}', matrix.part)") && block.includes('node scripts/ci-impact.mjs summary 600'), group)
    }
    assert.doesNotMatch(block, /node: \[/, group)
    assert.doesNotMatch(block, /^\s+os: \[/m, group)
    assert.match(block, /CI_TEST_FILES:/, group)
    assert.match(block, /node scripts\/ci-impact\.mjs run/, group)
  }
  const plugin = text.split('\n  plugin:\n')[1]?.split(/\n  [\w-]+:\n/)[0]
  assert.match(plugin, /os: \$\{\{ fromJSON\(needs\.impact\.outputs\.plugin_os\) \}\}/)
  // Every job that runs tests on Windows turns real-time scanning off first, on Windows only.
  for (const group of ['board', 'messaging', 'tooling', 'npm', 'plugin', 'installers', 'remote', 'journeys', 'browser']) {
    const steps = text.split('\n  ' + group + ':\n')[1]?.split(/\n  [\w-]+:\n/)[0]?.split('\n    steps:\n')[1] ?? ''
    assert.ok(steps.startsWith('      # Real-time scanning'), group)
    const first = steps.split('\n      - ')[1] ?? ''
    assert.ok(first.includes("if: runner.os == 'Windows'") && first.includes('Set-MpPreference -DisableRealtimeMonitoring $true'), group)
  }
})

test('workflow selection uses base rules and bootstraps with every group selected', async () => {
  const text = await workflow()
  assert.match(text, /node checker\/scripts\/ci-impact\.mjs plan/)
  assert.doesNotMatch(text, /node source\/scripts\/ci-impact\.mjs plan/)
  assert.match(text, /full:true,checks:Object\.fromEntries\(groups\.map\(g=>\[g,true\]\)\)/)
  assert.match(text, /if: always\(\)\n    needs: \[impact, board, messaging, tooling, npm, plugin, installers, remote, journeys, browser, generated\]/)
})

test('workflow places runner temporary paths on the browser step and retains seven-day evidence', async () => {
  const text = await workflow()
  const block = text.split('\n  browser:\n')[1]?.split('\n  generated:\n')[0]
  assert.ok(block)
  assert.equal(block.includes('\n    env:\n'), false)
  assert.match(block, /AGENT_BOARD_PLAYWRIGHT_MODULE:/)
  assert.match(block, /retention-days: 7/)
})

test('the exact workflow validation script rejects a skipped selected job and failed planner', async () => {
  const { spawnSync } = await import('node:child_process')
  const text = await workflow()
  const block = text.split('\n  ci-validation:\n')[1]
  const code = block.slice(block.indexOf('          const needs'), block.lastIndexOf('          NODE')).replace(/^          /gm, '')
  const plan = makePlan(['bin/agent-board.mjs'], options())
  const needs = { impact: { result: 'success' }, ...Object.fromEntries(Object.entries(resultsFor(plan)).map(([g,result]) => [g,{result}])) }
  const invoke = (p,n) => spawnSync(process.execPath, ['--input-type=module','-e',code], {
    env: { ...process.env, CI_PLAN: JSON.stringify(p), CI_NEEDS: JSON.stringify(n) },
    encoding: 'utf8',
  })
  assert.equal(invoke(plan, needs).status, 0)
  assert.notEqual(invoke(plan, { ...needs, npm: { result: 'skipped' } }).status, 0)
  assert.notEqual(invoke(plan, { ...needs, impact: { result: 'failure' } }).status, 0)
  assert.notEqual(invoke({ ...plan, full: 'false' }, needs).status, 0)
})

test('trusted base planning precedes all head test execution', async () => {
  const text = await workflow()
  assert.ok(text.indexOf('name: Plan from trusted base rules') < text.indexOf('name: Selector contract tests'))
})

test('deleted tests stay out of the final full fallback inventory', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async base => withFixture(async head => {
    for (const root of [base, head]) await writeFixture(root, 'tests/live.test.mjs', 'export const live = true')
    await writeFixture(base, 'tests/deleted.test.mjs', 'export const before = true')
    const plan = await buildPlan(['tests/deleted.test.mjs'], { roots: [base, head] })
    assert.equal(plan.full, true)
    assert.deepEqual(plan.testFiles.board, ['tests/live.test.mjs'])
    assert.ok(plan.notes.some(note => note.includes('removed test')))
  }))
})

test('a runtime change mixed with a test deletion runs only the remaining head tests', async () => {
  const { buildPlan } = await import('../scripts/ci-impact.mjs')
  await withFixture(async base => withFixture(async head => {
    for (const root of [base, head]) {
      await writeFixture(root, 'hooks/runtime.ts', 'export const value = true')
      await writeFixture(root, 'tests/live.test.mjs', "import '../hooks/runtime.ts'")
    }
    await writeFixture(base, 'tests/deleted.test.mjs', "import '../hooks/runtime.ts'")
    const plan = await buildPlan(['hooks/runtime.ts','tests/deleted.test.mjs'], { roots: [base, head] })
    assert.equal(plan.full, false)
    assert.equal(plan.checks.board, true)
    assert.deepEqual(plan.testFiles.board, ['tests/live.test.mjs'])
  }))
})

test('the brief template retains the same local and CI execution policy as AGENTS', async () => {
  const { readFile } = await import('node:fs/promises')
  const agent = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  const brief = await readFile(new URL('../docs/dev/brief-rules.md', import.meta.url), 'utf8')
  const policy = agent.split('\n').find(line => line.startsWith('On your own computer,'))
  assert.ok(policy)
  assert.ok(brief.split('\n').includes('10. ' + policy))
})

// The browser job's tool install tries up to three times when the runner's Ubuntu package mirror is unreachable
// (#1460). Its loop runs here as written in the workflow, under the bash options Actions uses, with a stand-in
// installer that fails a set number of times and a sleep that returns at once.
const gitBash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash'
test('the browser tool install stops at its first success, tries three times and then fails', async () => {
  const text = await workflow()
  const step = text.slice(text.indexOf('- name: Install isolated browser test tools'))
  const start = step.indexOf('for try in 1 2 3; do')
  assert.ok(start > 0, 'the install step has its three-try loop')
  const loop = step.slice(start, step.indexOf('exit 1\n', start) + 'exit 1'.length)
  const root = await mkdtemp(join(tmpdir(), 'ab-install-loop-'))
  try {
    const cli = join(root, 'agent-board-playwright', 'node_modules', 'playwright', 'cli.js')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, "const fs = require('node:fs'); const n = Number(fs.readFileSync(process.env.TRIES, 'utf8')) + 1\n" +
      "fs.writeFileSync(process.env.TRIES, String(n)); process.exit(n <= Number(process.env.FAILS) ? 1 : 0)\n")
    const run = async fails => {
      const tries = join(root, `tries-${fails}`)
      await writeFile(tries, '0')
      const result = spawnSync(gitBash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'sleep() { echo "slept $1"; }\n' + loop], {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: root, TRIES: tries, FAILS: String(fails), PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH },
      })
      return { status: result.status, tries: Number(await readFile(tries, 'utf8')), out: result.stdout }
    }
    assert.deepEqual(await run(0), { status: 0, tries: 1, out: '' })
    const flaky = await run(2)
    assert.deepEqual([flaky.status, flaky.tries], [0, 3])
    assert.equal(flaky.out, '::warning::browser tool install failed (try 1 of 3); trying again in 20 s\nslept 20\n' +
      '::warning::browser tool install failed (try 2 of 3); trying again in 40 s\nslept 40\n')
    const down = await run(3)
    assert.deepEqual([down.status, down.tries], [1, 3])
    assert.match(down.out, /slept 40\n::error::browser tool install failed three times\n$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

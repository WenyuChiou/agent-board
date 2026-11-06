import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
    ['scripts/changelog-fold.mjs', ['tooling']],
    ['scripts/team-stats.mjs', ['tooling']],
    ['scripts/review-queue.mjs', ['tooling']],
    ['scripts/review-queue-post.mjs', ['tooling']],
    ['tests/pr-check.test.mjs', ['tooling']],
    ['tests/preflight.test.mjs', ['tooling']],
    ['tests/changelog-fold.test.mjs', ['tooling']],
    ['tests/team-stats.test.mjs', ['tooling']],
    ['tests/review-queue.test.mjs', ['tooling']],
    ['tests/review-queue-post.test.mjs', ['tooling']],
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

test('a self-parted test file runs whole in every part and keeps its share, so the parts together run each of its tests once', async () => {
  const { testRuns, partTest, selfPartedTests } = await import('../scripts/ci-impact.mjs')
  const files = ['tests/a.test.mjs', 'tests/board.test.mjs', 'tests/b.test.mjs', 'tests/codex-local.test.mjs']
  assert.deepEqual(testRuns(files), [['--test', ...files]])
  assert.deepEqual(testRuns(files, { part: '1/1' }), [['--test', ...files]])
  assert.deepEqual(testRuns(files, { part: '1/2' }), [['--test', 'tests/a.test.mjs', 'tests/board.test.mjs', 'tests/codex-local.test.mjs']])
  assert.deepEqual(testRuns(files, { part: '2/2' }), [['--test', 'tests/b.test.mjs', 'tests/board.test.mjs', 'tests/codex-local.test.mjs']])
  assert.deepEqual(testRuns(['tests/board.test.mjs'], { isSerial: true, part: '1/2' }), [['--test', '--test-concurrency=1', 'tests/board.test.mjs']])
  const ran = part => {
    const names = []
    const test = partTest(name => names.push(name), part)
    for (const name of ['t0', 't1', 't2', 't3', 't4']) test(name)
    return names
  }
  assert.deepEqual(ran(''), ['t0', 't1', 't2', 't3', 't4'])
  assert.deepEqual(ran('1/2'), ['t0', 't2', 't4'])
  assert.deepEqual(ran('2/2'), ['t1', 't3'])
  assert.deepEqual([...ran('1/3'), ...ran('2/3'), ...ran('3/3')].sort(), ['t0', 't1', 't2', 't3', 't4'])
  assert.throws(() => partTest(() => {}, '2/1'), /test part/)
  for (const path of selfPartedTests) assert.match(await readFile(path, 'utf8'), /^const test = partTest\(nodeTest\)$/m, path)
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

test('the board time check fails a file over its budget and a part over its budget, naming the slow files', async () => {
  const { checkBoardTimes, BOARD_FILE_BUDGETS_MS, BOARD_PART_BUDGET_MS } = await import('../scripts/ci-impact.mjs')
  assert.equal(BOARD_FILE_BUDGETS_MS['tests/board.test.mjs'], 140_000)
  assert.equal(BOARD_PART_BUDGET_MS, 480_000)
  const base = { version: 1, part: '1/4', serial: true, totalMs: 300_000, files: [{ path: 'tests/board.test.mjs', ms: 100_000 }, { path: 'tests/ws-stdio.test.mjs', ms: 5_000 }] }
  assert.deepEqual(checkBoardTimes(base), { ok: true, errors: [] })
  // A file exactly at its budget is not over it.
  assert.deepEqual(checkBoardTimes({ ...base, files: [{ path: 'tests/board.test.mjs', ms: 140_000 }] }), { ok: true, errors: [] })
  const overFile = checkBoardTimes({ ...base, files: [{ path: 'tests/board.test.mjs', ms: 150_000 }] })
  assert.equal(overFile.ok, false)
  assert.deepEqual(overFile.errors, ['tests/board.test.mjs took 150s, over its 140s budget'])
  const overPart = checkBoardTimes({ ...base, totalMs: 500_000, files: [
    { path: 'tests/board.test.mjs', ms: 100_000 },
    { path: 'tests/codex-local.test.mjs', ms: 150_000 },
    { path: 'tests/legacy-connect.test.mjs', ms: 100_000 },
  ] })
  assert.equal(overPart.ok, false)
  assert.deepEqual(overPart.errors, ['board part 1/4 took 500s, over its 480s budget; slowest files: tests/codex-local.test.mjs 150s, tests/board.test.mjs 100s, tests/legacy-connect.test.mjs 100s'])
  assert.deepEqual(checkBoardTimes(null), { ok: false, errors: ['missing or invalid board timings'] })
  // A file outside the board group, and a file with no time recorded, are not judged.
  const unjudged = { ...base, totalMs: 100_000, files: [{ path: 'tests/messaging.test.mjs', ms: 999_000 }, { path: 'tests/board.test.mjs', ms: null }] }
  assert.deepEqual(checkBoardTimes(unjudged), { ok: true, errors: [] })
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
    assert.deepEqual(partFiles(files, '1/2'), ['tests/ws-stdio.test.mjs', 'tests/board.test.mjs'])
    const calls = []
    runTestFiles(files, '1/2', (command, args) => { calls.push(args); return { status: 0 } }, 'win32')
    assert.deepEqual(calls, [
      ['--test', '--test-concurrency=1', 'tests/ws-stdio.test.mjs'],
      ['--test', '--test-concurrency=1', 'tests/board.test.mjs'],
    ])
    const recorded = JSON.parse(await readFile(process.env.CI_TEST_TIMINGS, 'utf8'))
    assert.equal(recorded.version, 1)
    assert.equal(recorded.part, '1/2')
    assert.equal(recorded.serial, true)
    assert.equal(typeof recorded.totalMs, 'number')
    assert.equal(recorded.files.length, 2)
    assert.equal(recorded.files[0].path, 'tests/ws-stdio.test.mjs')
    assert.equal(typeof recorded.files[0].ms, 'number')
    // A failing file does not stop the rest, and the times are still recorded.
    const failing = []
    assert.throws(() => runTestFiles(files, '1/2', (command, args) => { failing.push(args); return { status: args.includes('tests/board.test.mjs') ? 1 : 0 } }, 'win32'), /selected tests failed: 1/)
    assert.equal(failing.length, 2)
    const recordedAfterFailure = JSON.parse(await readFile(process.env.CI_TEST_TIMINGS, 'utf8'))
    assert.equal(recordedAfterFailure.files.length, 2)
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
    const run = () => spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env: { ...process.env, CI_TEST_TIMINGS: path } })
    await writeFile(path, JSON.stringify({ version: 1, part: '1/4', serial: true, totalMs: 300_000, files: [{ path: 'tests/board.test.mjs', ms: 100_000 }] }))
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
    assert.match(red.stdout, /tests\/board\.test\.mjs took 200s, over its 140s budget/)
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
  return readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
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
  // keeps ten minutes: the board in six (#1059), the journeys in two (#910).
  const parts = (node, n) => Array.from({ length: n }, (_, i) => `{"os":"windows-latest","node":${node},"part":"${i + 1}/${n}"}`).join(',')
  const ubuntu = '{"os":"ubuntu-latest","node":22,"part":"1/1"}', ubuntu24 = '{"os":"ubuntu-latest","node":24,"part":"1/1"}'
  assert.ok(text.includes(`board_matrix: \${{ ${onPr} && '[${ubuntu},${parts(24, 6)}]' || '[${ubuntu},${ubuntu24},${parts(22, 6)},${parts(24, 6)}]' }}`))
  assert.ok(text.includes(`journeys_matrix: \${{ ${onPr} && '[${ubuntu},${parts(24, 2)}]' || '[${ubuntu},${ubuntu24},${parts(22, 2)},${parts(24, 2)}]' }}`))
  for (const group of ['board', 'messaging', 'tooling', 'npm', 'journeys']) {
    const block = text.split('\n  ' + group + ':\n')[1]?.split(/\n  [\w-]+:\n/)[0]
    assert.ok(block, group)
    const matrix = group === 'board' || group === 'journeys' ? `${group}_matrix` : 'node_matrix'
    assert.ok(block.includes(`include: \${{ fromJSON(needs.impact.outputs.${matrix}) }}`), group)
    if (group === 'board' || group === 'journeys') {
      assert.ok(block.includes('CI_TEST_PART: ${{ matrix.part }}') && block.includes('timeout-minutes: 10'), group)
      assert.ok(block.includes("CI_TEST_SERIAL: ${{ runner.os == 'Windows' && '1' || '' }}"), group)
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

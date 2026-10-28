import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { test } from 'node:test'
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
    ['tests/pr-check.test.mjs', ['tooling']],
    ['tests/preflight.test.mjs', ['tooling']],
    ['tests/changelog-fold.test.mjs', ['tooling']],
    ['tests/team-stats.test.mjs', ['tooling']],
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

test('dependency walking records the generated board bundle without parsing its imports', async () => {
  await withFixture(async root => {
    await writeFixture(root, 'scripts/entry.mjs', "import '../hooks/board-script.ts'")
    await writeFixture(root, 'hooks/board-script.ts', "import './generated-internal.ts'")
    await writeFixture(root, 'hooks/generated-internal.ts', 'export const internal = true')
    const dependencies = await walkDependencies(root, ['scripts/entry.mjs'])
    assert.deepEqual([...dependencies].sort(), ['hooks/board-script.ts', 'scripts/entry.mjs'])
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

test('ci result validation rejects incomplete or non-boolean selection metadata', () => {
  const plan = makePlan([], options())
  const incomplete = structuredClone(plan)
  delete incomplete.checks.board
  assert.equal(checkResults(incomplete, resultsFor(plan)).ok, false)
  assert.equal(checkResults({ ...plan, full: 'false' }, resultsFor(plan)).ok, false)
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
  assert.ok(text.includes(`plugin_os: \${{ ${onPr} && '["ubuntu-latest"]' || '["ubuntu-latest","windows-latest"]' }}`))
  for (const group of ['board', 'messaging', 'tooling', 'npm', 'journeys']) {
    const block = text.split('\n  ' + group + ':\n')[1]?.split(/\n  [\w-]+:\n/)[0]
    assert.ok(block, group)
    assert.match(block, /include: \$\{\{ fromJSON\(needs\.impact\.outputs\.node_matrix\) \}\}/, group)
    assert.doesNotMatch(block, /node: \[/, group)
    assert.doesNotMatch(block, /^\s+os: \[/m, group)
    assert.match(block, /CI_TEST_FILES:/, group)
    assert.match(block, /node scripts\/ci-impact\.mjs run/, group)
  }
  const plugin = text.split('\n  plugin:\n')[1]?.split(/\n  [\w-]+:\n/)[0]
  assert.match(plugin, /os: \$\{\{ fromJSON\(needs\.impact\.outputs\.plugin_os\) \}\}/)
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

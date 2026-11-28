import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_ENTRY, bundleFiles, isBundleFile } from './bundle-text.mjs'
import { hasReceiverRecord } from './messaging-matrix.mjs'

export const GROUPS = ['board', 'messaging', 'tooling', 'npm', 'plugin', 'installers', 'remote', 'journeys', 'browser', 'generated']
const systems = ['ubuntu-latest', 'windows-latest']
const toolingTests = ['pr-check', 'preflight', 'fail-first', 'changelog-fold', 'team-stats', 'review-queue', 'review-queue-post', 'pr-check-rerun', 'code-rules', 'ci-sampler'].map(name => 'tests/' + name + '.test.mjs')
const messagingTests = ['tests/exchange.test.mjs', 'tests/messaging.test.mjs']
const safePath = value => {
  if (typeof value !== 'string' || !value || /[\0\r\n\\:]/.test(value) || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid repository path')
  return value
}
export const groupForTest = path => {
  if (path === 'tests/ci-impact.test.mjs') return null
  if (/^tests\/browser\/[^/]+\.test\.mjs$/.test(path)) return 'browser'
  if (/^tests\/e2e\/[^/]+\.test\.mjs$/.test(path)) return 'journeys'
  if (/^tests\/[^/]+\.test\.tsx?$/.test(path)) return 'plugin'
  if (toolingTests.includes(path)) return 'tooling'
  if (messagingTests.includes(path)) return 'messaging'
  if (path === 'tests/npm-package.test.mjs') return 'npm'
  if (/^tests\/[^/]+\.test\.mjs$/.test(path)) return 'board'
  return null
}

const matrixTest = 'tests/messaging-matrix.test.mjs'
const isMatrixDocument = path => /^(?:README(?:\.[\w-]+)?\.md|docs\/MESSAGING\.md|docs\/validation\/.+\.md)$/.test(path)
const hasRecord = (root, path) => {
  if (!/^(?:scripts|hooks)\/.+\.(?:mjs|tsx?)$/.test(path) || !existsSync(join(root, path))) return false
  return hasReceiverRecord(readFileSync(join(root, path), 'utf8'))
}

export const makePlan = (files, options = {}) => {
  if (!Array.isArray(files)) throw new Error('changed paths must be an array')
  files = [...new Set(files.map(safePath))].sort()
  const checks = Object.fromEntries(GROUPS.map(group => [group, false]))
  const testFiles = Object.fromEntries(GROUPS.map(group => [group, [...(options.tests?.[group] ?? [])]]))
  const generated = { bundle: false, released: false }
  const installers = new Set()
  const reasons = []
  let full = options.forceFull === true
  const select = (group, path) => {
    checks[group] = true
    reasons.push({ group, path })
  }
  for (const path of files) {
    if (/^(?:AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md|package(?:-lock)?\.json|tsconfig\.json|scripts\/ci-impact\.mjs|docs\/FORMAT\.md)$/.test(path) || path.startsWith('.github/') || path.startsWith('.claude-plugin/')) {
      full = true
      reasons.push({ group: 'full', path })
      continue
    }
    let known = false
    for (const group of GROUPS) if (options.deps?.[group]?.has(path)) {
      select(group, path)
      known = true
    }
    if (options.bundleSources?.has(path) || isBundleFile(path) || path === 'scripts/build-board.ts') {
      generated.bundle = true
      known = true
    }
    // Selects without classifying: a new record file still goes full, for tests the walk can't see.
    if (options.matrixInputs?.has(path)) select('board', path)
    if (['hooks/released.ts', 'tests/fixtures/released.ts', 'scripts/build-released.ts'].includes(path)) {
      generated.released = true
      select('generated', path)
      known = true
    }
    // The plugin step's own runner: a change to it must run the plugin job (the walk only reaches its board test).
    if (path === 'scripts/plugin-tests.mjs') {
      select('plugin', path)
      known = true
    }
    const testGroup = groupForTest(path)
    if (testGroup) {
      select(testGroup, path)
      if (!testFiles[testGroup].includes(path)) testFiles[testGroup].push(path)
      known = true
    }
    if (path === 'tests/ci-impact.test.mjs') known = true
    if (/^scripts\/remote-reporter\/[^/]+\.py$/.test(path)) {
      select('remote', path)
      known = true
    }
    if (path === 'bin/agent-board.mjs') { select('npm', path); known = true }
    if (/^scripts\/(?:pr-check|preflight|fail-first|changelog-fold|team-stats|review-queue|review-queue-post|pr-check-rerun|code-rules)\.(?:mjs|json)$/.test(path) || path === 'scripts/ci-sampler.ps1') { select('tooling', path); known = true }
    if (/^(?:scripts\/setup|tests\/setup\.check)\.(?:sh|ps1)$/.test(path)) {
      select('installers', path)
      installers.add(path.endsWith('.ps1') ? 'windows-latest' : 'ubuntu-latest')
      known = true
    }
    if (known) continue
    if (/^(?:README(?:\.[\w-]+)?\.md|CHANGELOG\.md|LICENSE|CODE_OF_CONDUCT\.md|SECURITY\.md|greptile\.json)$/.test(path) || /^(?:docs|changelog\.d)\/.*\.(?:md|svg|png|jpg|webp|gif)$/.test(path)) continue
    full = true
    reasons.push({ group: 'full', path, reason: 'unclassified path' })
  }
  if (full) {
    for (const group of GROUPS) checks[group] = true
    generated.bundle = generated.released = true
  }
  // The plugin loads hooks/ (the generated board bundle among them), its manifest, package.json (how Node loads
  // its modules) and its line-ending policy at run time, under the Claude Code version test.yml pins, and a
  // Windows-only load failure (a CRLF bundle, #589) passed on Ubuntu twice. Test files and docs that only select the
  // plugin group stay on Ubuntu, and a hooks/ file the plugin does not load selects no plugin check at all.
  const reachesPluginRuntime = files.some(path => path.startsWith('hooks/') || path.startsWith('.claude-plugin/') || path === 'package.json' || path === '.gitattributes' || path === '.github/workflows/test.yml' || path === 'scripts/plugin-tests.mjs' || options.pluginRuntime?.has(path))
  if (checks.installers && (full || !installers.size || files.some(path => options.deps?.installers?.has(path) && !/^(?:scripts\/setup|tests\/setup\.check)\.(?:sh|ps1)$/.test(path)))) {
    for (const system of systems) installers.add(system)
  }
  // Generated verification is an independent job even when no product consumer changed.
  checks.generated ||= generated.bundle || generated.released
  return {
    version: 1, full, files, checks, testFiles, generated,
    installerMatrix: systems.filter(system => installers.has(system)),
    pluginMatrix: checks.plugin && reachesPluginRuntime ? [...systems] : [systems[0]],
    soakRecommended: files.some(path => /(?:lock|storage|archive|poll|queue|inbox|board-serve|board-cli|connect-worker|serve\.ts)/i.test(path)),
    reasons,
  }
}

export const checkResults = (plan, results) => {
  const errors = []
  if (!plan || plan.version !== 1 || typeof plan.full !== 'boolean' || !plan.checks || GROUPS.some(group => typeof plan.checks[group] !== 'boolean') || !results || typeof results !== 'object') return { ok: false, errors: ['missing or invalid CI plan/results'] }
  for (const group of GROUPS) {
    const required = plan.full || plan.checks[group]
    const status = results[group]
    if (typeof status !== 'string') errors.push(group + ': missing result')
    else if (required ? status !== 'success' : !['success', 'skipped'].includes(status)) errors.push(group + ': ' + status)
  }
  for (const [group, status] of Object.entries(results)) if (!GROUPS.includes(group) && (plan.full ? status !== 'success' : !['success', 'skipped'].includes(status))) errors.push(group + ': ' + status)
  return { ok: errors.length === 0, errors }
}

// The time check (#902 step 4): a board part over its budget fails the check. A file over 70% of
// its budget fails a pull request and is reported on other events (#1323). The file budgets come
// from step 1's Windows board job logs (run 41985005370, main 63c29bb, then four parts): a file's total
// there is summed across the eight board jobs, so one job's share is the total / 8 for a self-parted file (a quarter
// of its tests in every job) and / 2 for a file that runs in one part per Node version. Each budget
// is that share x 1.5, rounded up to five seconds, with a sixty-second floor: the floor covers the
// board files step 1 never measured (added since) and keeps a small file from tripping on runner
// jitter — the slowest unmeasured file, mcp-tools, took 12.6 s on a Linux VM. Step 1 predates #957's
// speedups, so the budgets are upper bounds for the four files it touched, not tight fits.
// Re-derived (#1364): a budget of 1.5x one run puts its 70% line at 1.05x that run, while the same file on the
// same code varies far more between Windows runs (legacy-connect 105.6-148.0 s, prompt-hooks 29.1-46.2 s in the
// six test runs after #1361), so pull requests failed on runner speed alone. Every file whose slowest Windows
// Node 24 time in those runs, x 1.3, was over its 70% line now has budget = that slowest time x 1.3 / 0.7,
// rounded up to five seconds (board and codex-local: one part's share): it fails a pull request only when it
// runs 30% slower than its slowest recent run. page-regressions (6.5 s at most) keeps its old budget.
export const BOARD_FILE_BUDGETS_MS = Object.freeze({
  // Re-derived by the same rule (#1715): one part's share took up to 167.4 s on Windows Node 24 on #1709, which changes
  // these tests, and 86.9-147.0 s on main's last three pushes (Node 22 up to 174.7 s, run 44523734737).
  'tests/codex-local.test.mjs': 315_000, // slowest 167.4 s
  'tests/board.test.mjs': 200_000, // slowest 105.5 s
  // Since #1741 every part runs a share of this file; the budget stays the whole file's until main's runs give share
  // times to re-derive it from by the same rule.
  'tests/legacy-connect.test.mjs': 275_000, // slowest 148.0 s
  'tests/page-regressions.test.mjs': 90_000,
  'tests/codex-fallback.test.mjs': 115_000, // slowest 60.0 s
  // Re-derived by the same rule (#1603): 49.3-67.9 s on Windows Node 24 on code that does not touch it; 67.9 s in run 43899299170.
  'tests/prompt-hooks.test.mjs': 130_000, // slowest 67.9 s
  // Grew past the floor with #1162's terminal setup tests (#1159); slowest 52.6 s after #1361.
  'tests/setup-guidance.test.mjs': 100_000,
  // Grew with #1302's two upgrade tests: 57.6 s on Windows Node 24 with the same two journeys on #1328 (run 43181075103).
  // Re-derived by the same rule (#1715): up to 80.6 s on Windows Node 24 on #1709, which changes these tests; 65.9 s on
  // Node 24 and 83.8 s on Node 22 on main after #1686 (run 44523734737).
  // Grew with #1730's three Windows tests that start setup from a copied Node: 109.1 s on Windows Node 24 (run
  // 44681768984), over the 105 s line of 150 s. By the rule of #1715: 109.1 x 1.3 / 0.7, rounded up to five seconds.
  // Grew with #1778's `setup --update` tests (#1314): 24 tests, 50.0 s of test time in its part. 170.8 s on Windows Node 24
  // (run 45073388887, attempt 2), over the 143.5 s line of 205 s. By the rule of #1715: 170.8 x 1.3 / 0.7, rounded up to five seconds.
  // Since #1912 each part runs a share; as for legacy-connect, keep the whole-file budget until main measures its shares.
  'tests/host-upgrade.test.mjs': 320_000, // slowest 170.8 s
  // Re-derived by the same rule (#1715): 60.6-73.4 s on Windows Node 24 on #1709, which adds terminal setup tests here.
  'tests/setup-terminal.test.mjs': 140_000, // slowest 73.4 s
  // Over the 42 s line (70%) of the 60 s default: up to 47.1 s on Windows Node 24 on #1709, which does not touch it, and
  // 42.5 s on main (run 44464805292); main's Node 22 runs report up to 46.0 s (#1715).
  'tests/approvals.test.mjs': 90_000, // slowest 47.1 s
  // Grew with #1339's lock tests (several wait out the 2 s bounded lock wait): 43.4 s on Windows Node 24 (run 43190652904).
  'tests/settings-symlink.test.mjs': 85_000, // slowest 43.4 s
  // New with #1366 and self-parted since its round 18, so this is one part's share. The whole file took 164.0 s on
  // Windows Node 24 (run 43644841624); dealt out six ways by its tests' times there, R33 one test per call, the largest
  // share is 40.6 s, about 44 s with the file's start. An estimate until a parted run is timed: 44 x 1.3 / 0.7.
  'tests/opencode-receiver.test.mjs': 85_000, // one part's share, about 44 s
  // New with #1438 (merge-check runs git in temporary repositories): 46.1 and 46.4 s on Windows Node 24 (#1464).
  'tests/merge-check.test.mjs': 90_000, // slowest 46.4 s
  // Grew with #1680's eleven removal re-read tests: up to 49.0 s on Windows Node 24 (run 44650276536), over the 42 s
  // line of the 60 s default. By the rule of #1715: 49 x 1.3 / 0.7, rounded up to five seconds.
  'tests/setup-sidecar.test.mjs': 95_000, // slowest 49.0 s
  // Grew with #1881's test of the 20 s clock (#1843), which waits the real 20 s: 56.6 s on Windows Node 24 (run
  // 45763999753), over the 42 s line of the 60 s default. By the rule of #1715: 56.6 x 1.3 / 0.7, rounded up to five seconds.
  'tests/serve-watch.test.mjs': 110_000, // slowest 56.6 s
})
export const BOARD_FILE_BUDGET_DEFAULT_MS = 60_000
// Re-derived, not the issue's 420 s: Windows board part job walls across the last four main runs
// (3485740, 4617bc1, e30fe0a, 01cdc5a) run 206-504 s, the slowest part (1/4) 347-504 s, so a 420 s
// threshold on the job wall already fails on main. Checkout, Node setup and the first PowerShell and
// Python starts take roughly 30-56 s of the wall (43 s on the slowest job), which puts part 1/4 test
// execution at 456 s at worst (the test step of e30fe0a N22 part 1/4); 480 s is about 5% above that
// and keeps the job wall under the ten-minute timeout.
export const BOARD_PART_BUDGET_MS = 480_000

const seconds = ms => (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)

export const checkBoardTimes = (timings, { isPullRequest = true } = {}) => {
  const errors = []
  const warnings = []
  if (!timings || typeof timings !== 'object' || !Array.isArray(timings.files) || typeof timings.totalMs !== 'number') return { ok: false, errors: ['missing or invalid board timings'], warnings }
  const boardFiles = timings.files.filter(file => groupForTest(file.path) === 'board')
  const timed = boardFiles.filter(file => typeof file.ms === 'number')
  for (const file of timed) {
    const budget = BOARD_FILE_BUDGETS_MS[file.path] ?? BOARD_FILE_BUDGET_DEFAULT_MS
    const limit = budget * 7 / 10
    if (file.ms > limit) {
      const message = file.path + ' took ' + seconds(file.ms) + 's, over 70% of its ' + seconds(budget) + 's budget (' + seconds(limit) + 's)'
      if (isPullRequest) errors.push(message)
      else warnings.push(message)
    }
  }
  if (boardFiles.length && timings.totalMs > BOARD_PART_BUDGET_MS) {
    const slowest = [...timed].sort((a, b) => b.ms - a.ms).slice(0, 5)
    errors.push('board part ' + (timings.part || '1/1') + ' took ' + seconds(timings.totalMs) + 's, over its ' + seconds(BOARD_PART_BUDGET_MS) + 's budget' + (slowest.length ? '; slowest files: ' + slowest.map(file => file.path + ' ' + seconds(file.ms) + 's').join(', ') : ''))
  }
  return { ok: errors.length === 0, errors, warnings }
}

// Where one run leaves its per-file times for the time check step below: the runner's temp folder
// on CI, the OS temp folder elsewhere. A run outside CI records nothing unless CI_TEST_TIMINGS
// names a file, so a local run leaves no stray file behind.
export const timingsPath = () => process.env.CI_TEST_TIMINGS
  || (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'agent-board-test-timings.json') : null)
  || join(tmpdir(), 'agent-board-test-timings.json')

export const readBoardTimings = (path = timingsPath()) => JSON.parse(readFileSync(path, 'utf8'))

// Keep literals as tokens so braces and helper names inside prose cannot become code.
export const codeTokens = text => {
  const tokens = []
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|=>|\?\.|\.\.\.|[^\s]/gy
  let match
  let line = 1
  while ((match = pattern.exec(text))) {
    const value = match[0]
    if (!/^\s|^\/\/|^\/\*/.test(value)) {
      if (value === '/' && (!tokens.length || /^(?:=|\(|\[|,|:|return|=>|!|\?|\|\||&&)$/.test(tokens.at(-1).value))) {
        const regex = /^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\\r\n])+\/[a-z]*/.exec(text.slice(match.index))
        if (regex) {
          pattern.lastIndex = match.index + regex[0].length
          tokens.push({ value: '<regex>', line })
          continue
        }
      }
      const isString = /^["'`]/.test(value)
      tokens.push({ value: isString ? value.slice(1, -1).replace(/\\(['"`\\])/g, '$1') : value, raw: value, isString, line })
    }
    line += (value.match(/\n/g) ?? []).length
  }
  return tokens
}

export const walkDependencies = async (root, entryPaths) => {
  root = realpathSync(root)
  const dependencies = new Set()
  const visit = path => {
    path = safePath(path)
    if (dependencies.has(path)) return
    const absolute = resolve(root, path)
    const segments = path.split('/')
    for (let i = 1; i <= segments.length; i++) {
      const parent = join(root, ...segments.slice(0, i))
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('dependency traverses a symlink')
    }
    if (existsSync(absolute) && lstatSync(absolute).isDirectory()) return
    dependencies.add(path)
    // The entry is read for the parts it imports; the parts are strings only, and large.
    if (!existsSync(absolute) || (isBundleFile(path) && path !== BUNDLE_ENTRY) || !/\.(?:mjs|cjs|js|ts|tsx)$/.test(path)) return
    const tokens = codeTokens(readFileSync(absolute, 'utf8'))
    const add = specifier => {
      if (!specifier.startsWith('.')) return
      const target = resolve(dirname(absolute), specifier)
      const rel = relative(root, target).replaceAll('\\', '/')
      if (rel === '') return
      safePath(rel)
      const candidates = [rel, rel + '.ts', rel + '.tsx', rel + '.mjs', rel + '.js', rel + '/index.ts']
      const found = candidates.find(candidate => existsSync(resolve(root, candidate)) && lstatSync(resolve(root, candidate)).isFile())
      visit(found ?? rel)
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.isString) continue
      if (token.value === 'import' || token.value === 'export') {
        if (tokens[i + 1]?.value === 'type') continue
        if (token.value === 'import' && tokens[i + 1]?.isString) { add(tokens[i + 1].value); continue }
        if (token.value === 'import' && tokens[i + 1]?.value === '(' && tokens[i + 2]?.isString && tokens[i + 3]?.value === ')') {
          add(tokens[i + 2].value)
          continue
        }
        if (token.value === 'import' && ['.', '('].includes(tokens[i + 1]?.value)) continue
        for (let j = i + 1; j < Math.min(tokens.length, i + 100); j++) {
          if (tokens[j].value === 'from' && tokens[j + 1]?.isString) { add(tokens[j + 1].value); break }
          if ([';', '='].includes(tokens[j].value) || (j > i + 1 && ['import', 'export', 'const', 'test'].includes(tokens[j].value))) break
        }
      }
      if (token.value === 'new' && tokens[i + 1]?.value === 'URL' && tokens[i + 2]?.value === '(' && tokens[i + 3]?.isString && tokens.slice(i + 4, i + 10).map(item => item.value).join('') === ',import.meta.url') add(tokens[i + 3].value)
    }
  }
  for (const path of entryPaths) visit(path)
  return dependencies
}

const listTests = (root, folder, pattern) => existsSync(join(root, folder))
  ? readdirSync(join(root, folder)).filter(name => pattern.test(name)).map(name => folder + '/' + name)
  : []

export const buildPlan = async (files, { roots, forceFull = false, pairs }) => {
  if (!Array.isArray(roots) || !roots.length) throw new Error('base and head source roots are required')
  const tests = Object.fromEntries(GROUPS.map(group => [group, []]))
  const deps = Object.fromEntries(GROUPS.map(group => [group, new Set()]))
  const bundleSources = new Set()
  const pluginRuntime = new Set()
  const notes = []
  for (const root of [...new Set(roots)]) {
    const entries = [
      ...listTests(root, 'tests', /\.test\.(?:mjs|ts|tsx)$/),
      ...listTests(root, 'tests/e2e', /\.test\.mjs$/),
      ...listTests(root, 'tests/browser', /\.test\.mjs$/),
    ]
    for (const group of GROUPS) {
      const grouped = entries.filter(path => groupForTest(path) === group)
      for (const path of grouped) if (!tests[group].includes(path)) tests[group].push(path)
      for (const dependency of await walkDependencies(root, grouped)) deps[group].add(dependency)
    }
    for (const path of await walkDependencies(root, ['scripts/board-cli.ts', 'scripts/build-board.ts'])) bundleSources.add(path)
    // These data reads are not JS imports: retain explicit edges next to the dependency walker.
    for (const path of ['scripts/setup.sh', 'scripts/setup.ps1', 'scripts/claude-md-rule.md', 'AGENTS.md', ...bundleFiles(root), 'hooks/released.ts']) deps.installers.add(path)
    for (const path of ['bin/agent-board.mjs', 'scripts/setup-agent.mjs', 'scripts/setup-codex.mjs', ...bundleFiles(root), 'hooks/released.ts']) {
      for (const dependency of await walkDependencies(root, [path])) deps.npm.add(dependency)
    }
    // The browser journeys install the board with scripts/setup-agent.mjs, which runs setup-codex.mjs, both in child
    // processes the import walk cannot see, so a page change alone selected no browser check (#942 reached main untested).
    for (const path of ['scripts/setup-agent.mjs', 'scripts/setup-codex.mjs', ...bundleFiles(root), 'hooks/released.ts']) {
      for (const dependency of await walkDependencies(root, [path])) deps.browser.add(dependency)
    }
    for (const path of ['hooks/parse.ts', 'hooks/blocks.ts']) deps.remote.add(path)
    for (const path of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'docs/FORMAT.md']) deps.journeys.add(path)
    for (const path of ['hooks/register.tsx', 'hooks/hooks.json', 'types/index.d.ts']) {
      for (const dependency of await walkDependencies(root, [path])) {
        deps.plugin.add(dependency)
        pluginRuntime.add(dependency)
      }
    }
  }
  // Changes hidden behind the generated bundle affect every consumer of that bundle.
  for (const group of GROUPS) if ([...deps[group]].some(isBundleFile)) {
    for (const path of bundleSources) deps[group].add(path)
  }
  // Removed tests inform impact, but only existing head tests may be executed.
  const head = roots.at(-1)
  for (const group of GROUPS) tests[group] = tests[group].filter(path => existsSync(join(head, path))).sort()
  // The generated messaging table reads these without importing them, so the dependency walk can't see them.
  const matrixInputs = new Set(tests.board.includes(matrixTest) ? files.filter(path => isMatrixDocument(path) || roots.some(root => hasRecord(root, path))) : [])
  const plan = makePlan(files, { tests, deps, bundleSources, pluginRuntime, forceFull, matrixInputs })
  if (!plan.full && plan.checks.board && plan.reasons.filter(reason => reason.group === 'board').every(reason => matrixInputs.has(reason.path) && !deps.board.has(reason.path))) {
    plan.testFiles.board = [matrixTest]
  }
  if (!plan.full && files.length && files.every(path => /^README(?:\.[\w-]+)?\.md$/.test(path))) {
    plan.testFiles.journeys = tests.journeys.filter(path => path === 'tests/e2e/l0-readme.test.mjs')
    if (plan.checks.journeys && !plan.testFiles.journeys.length) throw new Error('README contract test is missing')
  }
  // Release fragments do not change which tests a test-only PR needs.
  const nonFragmentPaths = files.filter(path => !/^changelog\.d\/[^/]+\.md$/.test(path))
  const isOnlyTests = nonFragmentPaths.length > 0 && nonFragmentPaths.every(path => groupForTest(path) || path === 'tests/ci-impact.test.mjs')
  if (isOnlyTests && !plan.full) {
    for (const group of GROUPS) if (plan.checks[group]) {
      plan.testFiles[group] = tests[group].filter(path => files.includes(path))
      if (!plan.testFiles[group].length && ['board', 'messaging', 'tooling', 'npm', 'journeys', 'browser'].includes(group)) {
        plan.full = true
        notes.push('removed test has no runnable replacement: use complete checks')
      }
    }
  }
  const finalPlan = plan.full && notes.length ? makePlan(files, { tests, deps, bundleSources, pluginRuntime, forceFull: true }) : plan
  // Changed paths include deletions; runnable files must always come from the head.
  for (const group of GROUPS) finalPlan.testFiles[group] = finalPlan.testFiles[group].filter(path => existsSync(join(head, path)))
  return { ...finalPlan, notes, ...(pairs === undefined ? {} : { partMatrices: partMatrices(finalPlan, tests, pairs) }) }
}

const gitPaths = (root, base, head) => {
  if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) throw new Error('full base/head commit IDs are required')
  const result = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('cannot obtain complete changed paths: ' + (result.stderr || result.error?.message))
  return result.stdout.split('\0').filter(Boolean)
}

const emitPlan = plan => {
  console.log(JSON.stringify(plan, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    const output = { plan: JSON.stringify(plan), full: String(plan.full), installers_os: JSON.stringify(plan.installerMatrix.length ? plan.installerMatrix : systems), plugin_os: JSON.stringify(plan.pluginMatrix.length ? plan.pluginMatrix : systems) }
    for (const group of GROUPS) output[group] = String(plan.checks[group])
    for (const group of ['board', 'messaging', 'tooling', 'npm', 'journeys', 'browser']) output[group + '_tests'] = JSON.stringify(plan.testFiles[group])
    if (plan.partMatrices) for (const [group, matrix] of Object.entries(plan.partMatrices)) output[group + '_matrix'] = JSON.stringify(matrix)
    output.bundle = String(plan.generated.bundle)
    output.released = String(plan.generated.released)
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => key + '=' + value).join('\n') + '\n')
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '## Affected checks\n\n' + GROUPS.map(group => '- ' + group + ': ' + (plan.checks[group] ? 'selected' : 'not run (unaffected)')).join('\n') +
    '\n\nFull plan: ' + plan.full + '\n\nSoak recommended: ' + plan.soakRecommended + '\n\nChanged paths:\n' + plan.files.map(path => '- ' + path).join('\n') + '\n')
}

// A part such as 2/4 lets a long set fit several jobs (#899, #910). The files go out to the parts by their times, but a file is
// never split, so a file far longer than the rest splits its own tests instead: part i of n keeps the tests the deal below
// gives it, and the parts together run each test once.
const parsePart = part => {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(part)
  if (part !== '' && (!match || Number(match[1]) > Number(match[2]))) throw new Error('test part must be <index>/<total>, such as 1/2')
  return match ? { index: Number(match[1]), total: Number(match[2]) } : { index: 1, total: 1 }
}

// The files that split their own tests with partTest: on Windows codex-local took about 8 minutes and
// board about 5, each far longer than any other file (#899). messaging joined when the Windows exchange
// job used 75-80% of its 10 minutes (#1445). opencode-receiver joined when its fault matrix took it to 157.7 and
// 164.0 s, and the Windows board part that held it to 448.6 s of its 480 s (#1366, runs 43641832826, 43644841624).
// legacy-connect joined when, whole, it took 162.2 and 167.0 s in Windows Node 22 part 4 of 7 beside that part's share
// of codex-local, and the part ran 487.9 and 494.4 s of its 480 s on main e977c727 (#1741, run 44697238483).
// host-upgrade joined at 182.9 s in the refreshed table: Windows board part 6/10 ran 394.8 and 438.8 s of its 480 s
// on main 6881827b (#1912, run 45920668633).
export const selfPartedTests = ['tests/board.test.mjs', 'tests/codex-local.test.mjs', 'tests/host-upgrade.test.mjs', 'tests/legacy-connect.test.mjs', 'tests/messaging.test.mjs', 'tests/opencode-receiver.test.mjs']

// The table of times that deals both the files and the tests out to the parts (#1762): the time of each test file, and of each
// top-level test of a self-parted file, from a main run's job logs. `node scripts/ci-test-times.mjs <job logs>` writes it; see
// that script for when to refresh it.
const TIMES = (() => {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tests', 'ci-test-times.json')
  try {
    const table = JSON.parse(readFileSync(path, 'utf8'))
    if (!table || typeof table.files !== 'object' || typeof table.tests !== 'object') throw new Error('no files and tests')
    return table
  } catch (error) {
    throw new Error('cannot read ' + path + ': ' + error.message)
  }
})()
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const repoPath = path => relative(REPO_ROOT, path).split(/[\\/]/).join('/')

// A test with no time in the table (one added since the table was made) goes to the part its title hashes to, so adding a
// test moves no other.
const hashOf = text => {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0
  return hash
}

// The test file that called partTest: the first file in the stack that is not this one, else the file Node was started on.
const callerFile = () => {
  for (const frame of (new Error().stack ?? '').split('\n')) {
    const match = /(file:\/\/\/[^\s)]+?\.mjs)(?::\d+){2}/.exec(frame)
    if (!match) continue
    const path = repoPath(fileURLToPath(match[1]))
    if (path !== 'scripts/ci-impact.mjs') return path
  }
  return process.argv[1] ? repoPath(resolve(process.argv[1])) : ''
}

// Which part runs each test of a self-parted file that the table holds: the tests of the files that share jobs (the same
// group: the five board files, or messaging alone) go out together, slowest first, each to the part with the least time so
// far, so the parts of a job get the same time from all of them. It depends only on the table and the number of parts, so
// every job works out the same split and the parts together run each test once.
const dealCache = new WeakMap()
const dealTests = (times, total) => {
  if (!dealCache.has(times)) dealCache.set(times, new Map())
  const cache = dealCache.get(times)
  if (cache.has(total)) return cache.get(total)
  const deal = new Map(selfPartedTests.map(file => [file, new Map()]))
  for (const group of new Set(selfPartedTests.map(groupForTest))) {
    const tests = selfPartedTests.flatMap((file, order) => groupForTest(file) === group ? Object.entries(times.tests[file] ?? {}).map(([key, ms]) => ({ file, order, key, ms })) : [])
    tests.sort((a, b) => b.ms - a.ms || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const loads = Array(total).fill(0)
    for (const test of tests) {
      const lightest = loads.indexOf(Math.min(...loads))
      loads[lightest] += test.ms
      deal.get(test.file).set(test.key, lightest)
    }
  }
  cache.set(total, deal)
  return deal
}

// A repeated title is told apart by its place among the file's tests: the second is "title #2", as the table writes it.
export const partTest = (test, part = process.env.CI_TEST_PART ?? '', file = callerFile(), times = TIMES) => {
  const { index, total } = parsePart(part)
  const seen = new Map()
  const dealt = total === 1 ? undefined : dealTests(times, total).get(file)
  const runs = (...args) => {
    if (total === 1) return true
    const title = typeof args[0] === 'string' ? args[0] : typeof args[0] === 'function' ? args[0].name || '<anonymous>' : String(args[0]?.name ?? '')
    seen.set(title, (seen.get(title) ?? 0) + 1)
    const key = seen.get(title) === 1 ? title : title + ' #' + seen.get(title)
    return (dealt?.get(key) ?? hashOf(title) % total) === index - 1
  }
  // A test.skip or test.todo is counted and dealt like any other test: a job log lists it too, so the table counts it (#1762).
  return Object.assign((...args) => (runs(...args) ? test(...args) : undefined), {
    skip: (...args) => (runs(...args) ? test.skip(...args) : undefined),
    only: test.only,
    todo: (...args) => (runs(...args) ? test.todo(...args) : undefined),
  })
}

// A Windows job ran three spawn-heavy files at once on a 4-vCPU runner: every test slowed about 1.35x and the
// tightest timing budgets failed in turn (#910). Two files at a time leaves them room; serial stays one.
export const testArgs = (files, { isSerial = false, isWindows = false } = {}) => ['--test', ...(isSerial ? ['--test-concurrency=1'] : isWindows ? ['--test-concurrency=2'] : []), ...files]

// Taking every nth file by its place in the list put all four budgeted files in Windows part 2 of 6, which ran
// 445-497 s while the other parts ran 145-250 s (#1059, run 42281474369). So the files go out slowest first, each
// to the part with the least so far, and every job works out the same split, so the parts together run each file once.
// Each part starts from the time of the self-parted tests it runs (dealTests above), then takes the other files.
// A file weighs its time in the table (#1762), else the old estimates: about its slowest Windows time, read back from its
// budget (a budget is that time x 1.3 / 0.7, #1733), else 5 s. The one file with its own weight is the message-store
// journey, which is in no job the table was made from: l3c took 294.4 s in the Node 22 journeys part 2/2 that main's run
// 44601640119 cancelled at ten minutes (#1722), and 289.1 s of a 529 s part 2/2 on main 7685f8ed (run 44615703631), where no
// other journey in that part took more than 61.3 s. At this weight it gets a part to itself.
// The table is a measurement, and it goes stale as tests are added. When a pull request adds or removes many tests or a test
// file, refresh it in that pull request from the logs of the newest main run (one command: scripts/ci-test-times.mjs). A
// test the table does not know still runs, in the part its title hashes to; tests/ci-impact.test.mjs fails when the table
// says a part would take over its budget on a runner 1.6 times slower (BOARD_PART_BUDGET_MS), so a pull request that adds
// too much has to add a part or make tests faster.
const PART_WEIGHTS_MS = Object.freeze({ 'tests/e2e/l3c-message-store-ownership.test.mjs': 295_000 })
const partWeight = path => TIMES.files[path] ?? (BOARD_FILE_BUDGETS_MS[path] !== undefined ? Math.round(BOARD_FILE_BUDGETS_MS[path] * 0.7 / 1.3) : PART_WEIGHTS_MS[path] ?? 5_000)

// The split of a set of files into `total` parts: the files of each part, the time of its self-parted tests (its share), and
// its expected time in all.
const dealFiles = (files, total) => {
  const rest = files.filter(path => !selfPartedTests.includes(path))
  const shares = Array(total).fill(0)
  const deal = dealTests(TIMES, total)
  for (const file of selfPartedTests) if (files.includes(file)) for (const [key, part] of deal.get(file)) shares[part] += TIMES.tests[file][key]
  const loads = [...shares]
  const parts = Array.from({ length: total }, () => new Set())
  for (const path of [...rest].sort((a, b) => partWeight(b) - partWeight(a))) {
    const lightest = loads.indexOf(Math.min(...loads))
    loads[lightest] += partWeight(path)
    parts[lightest].add(path)
  }
  return { shares, loads, parts }
}

// What each part of `total` is expected to take, in ms, by the table: the self-parted tests, and in all.
export const partLoads = (files, total) => {
  const { shares, loads } = dealFiles(files, total)
  return { shares, loads }
}

// Today's number of parts of each split job on each system, on every Node line (#1917): the counts test.yml falls back to
// when the planner names no matrices, and the most a pull request's selection ever gets.
export const PART_COUNTS = Object.freeze({
  board: Object.freeze({ 'ubuntu-latest': 3, 'windows-latest': 10 }),
  messaging: Object.freeze({ 'ubuntu-latest': 2, 'windows-latest': 3 }),
  journeys: Object.freeze({ 'ubuntu-latest': 1, 'windows-latest': 3 }),
})

// How many of today's `total` parts a selection of a group needs (#1917): a part with no test file is a job started for
// nothing, and each job is one more chance of a runner fault. The limit is the heaviest part of today's full run of the
// group, `all`, which CI already runs, so no part gets longer than one CI runs today. A self-parted file deals its tests
// into today's parts, and a file with no time of its own in the table weighs a guess, so either keeps today's count.
export const partCount = (selected, all, total) => {
  if (total <= 1 || !selected.length) return total
  if (selected.some(path => selfPartedTests.includes(path) || TIMES.files[path] === undefined)) return total
  const limit = Math.max(...partLoads(all, total).loads)
  for (let count = 1; count < total; count++) if (Math.max(...partLoads(selected, count).loads) <= limit) return count
  return total
}

// The matrices of the split jobs for the (system, Node) pairs the workflow runs: today's counts on a full plan, else the
// count each pair's selection needs.
export const partMatrices = (plan, tests, pairs) => {
  if (!Array.isArray(pairs) || !pairs.length || pairs.some(pair => !systems.includes(pair?.os) || !Number.isInteger(pair?.node))) throw new Error('the Node pairs must be a list of {os, node}')
  return Object.fromEntries(Object.entries(PART_COUNTS).map(([group, counts]) => [group, pairs.flatMap(({ os, node }) => {
    const total = plan.full ? counts[os] : partCount(plan.testFiles[group], tests[group], counts[os])
    return Array.from({ length: total }, (_, index) => ({ os, node, part: (index + 1) + '/' + total }))
  })]))
}

// The Node run of one part: its share of the other files, and every self-parted file, which keeps its own
// share of tests. One run, so its files run side by side as they do without parts, or one at a time when serial.
export const partFiles = (files, part = '') => {
  const { index, total } = parsePart(part)
  if (total === 1) return [...files]
  const mine = dealFiles(files, total).parts[index - 1]
  return [...files.filter(path => !selfPartedTests.includes(path) && mine.has(path)), ...files.filter(path => selfPartedTests.includes(path))]
}

export const testRuns = (files, { isSerial = false, isWindows = false, part = '' } = {}) => {
  const { total } = parsePart(part)
  if (total === 1) return [testArgs(files, { isSerial, isWindows })]
  const share = partFiles(files, part)
  return share.length ? [testArgs(share, { isSerial, isWindows })] : []
}

const cleanupStaleTimings = (target, writeError, remove, stat) => {
  let cleanupProblem = null
  let entry
  try {
    entry = stat(target)
  } catch (statError) {
    if (statError?.code !== 'ENOENT' && statError?.code !== 'ENOTDIR') {
      cleanupProblem = 'could not inspect timings path: ' + statError.message
    }
  }
  if (entry !== undefined) {
    if (!entry.isFile()) {
      cleanupProblem = 'timings path is not a regular file'
    } else {
      try {
        remove(target)
      } catch (removeError) {
        if (removeError?.code !== 'ENOENT') {
          cleanupProblem = 'could not remove stale timings file: ' + removeError.message
        }
      }
    }
  }
  return cleanupProblem === null ? null : 'could not record test timings (' + writeError.message + '); ' + cleanupProblem
}

export const runTestFiles = (files, part = process.env.CI_TEST_PART ?? '', spawn = spawnSync, platform = process.platform, write = writeFileSync, remove = unlinkSync, stat = lstatSync) => {
  if (!Array.isArray(files) || !files.length || files.some(path => !/^tests\/(?:[\w-]+\/)*[\w.-]+\.test\.mjs$/.test(path) || !existsSync(path))) throw new Error('selected tests are empty, invalid or missing')
  // A self-parted file reads its part from CI_TEST_PART, so the child gets the part this run was given,
  // not whatever part the environment holds.
  const env = { ...process.env, CI_TEST_PART: part }
  const isSerial = process.env.CI_TEST_SERIAL === '1'
  const isWindows = platform === 'win32'
  const started = Date.now()
  // A serial run times one file at a time: the files already run one at a time there, so one Node run
  // per file costs one extra process start each and gives the time check a time per file. A parallel
  // run keeps its single run: timing one file at a time there would serialize the whole set.
  const runs = isSerial
    ? partFiles(files, part).map(file => testArgs([file], { isSerial: true, isWindows }))
    : testRuns(files, { isSerial, isWindows, part })
  // Every run goes ahead even when an earlier one failed, so one job shows all of its failures.
  const timed = []
  const failures = []
  for (const args of runs) {
    const fileStarted = Date.now()
    const result = spawn(process.execPath, args, { stdio: 'inherit', env })
    if (result.error) throw result.error
    if (isSerial) timed.push({ path: args.at(-1), ms: Date.now() - fileStarted })
    if (result.status !== 0) failures.push(result.status ?? result.signal)
  }
  const totalMs = Date.now() - started
  let timingsFailure = null
  if (process.env.CI_TEST_TIMINGS || process.env.CI === 'true') {
    const target = timingsPath()
    try {
      write(target, JSON.stringify({ version: 1, part, serial: isSerial, totalMs, files: isSerial ? timed : partFiles(files, part).map(path => ({ path, ms: null })) }, null, 2) + '\n')
    } catch (error) {
      console.error('agent-board: could not record test timings: ' + error.message)
      // Remove any stale regular timings file via lstat so check cannot pass on earlier data and symlinks/dirs stay intact (#1720).
      timingsFailure = cleanupStaleTimings(target, error, remove, stat)
    }
  }
  if (failures.length || timingsFailure !== null) {
    const parts = []
    if (failures.length) parts.push('selected tests failed: ' + failures.join(', '))
    if (timingsFailure !== null) parts.push(timingsFailure)
    throw new Error(parts.join('; '))
  }
}

const main = async () => {
  if (process.argv[2] === 'run') { runTestFiles(JSON.parse(process.env.CI_TEST_FILES)); return }
  if (process.argv[2] === 'check') {
    let timings
    try {
      timings = readBoardTimings()
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (process.env.CI === 'true') {
          console.log('time budget: no test timings recorded on CI; cannot check board time budgets (the run step could not write them)')
          process.exitCode = 1
          return
        }
        console.log('no test timings recorded; nothing to check')
        return
      }
      throw error
    }
    const result = checkBoardTimes(timings, { isPullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request' })
    const slowest = (timings.files ?? []).filter(file => typeof file.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 3)
    console.log('board part ' + (timings.part || '1/1') + ': total ' + seconds(timings.totalMs) + 's of ' + seconds(BOARD_PART_BUDGET_MS) + 's budget' + (slowest.length ? '; slowest files: ' + slowest.map(file => file.path + ' ' + seconds(file.ms) + 's').join(', ') : '; per-file times are recorded on serial runs only'))
    for (const error of result.errors) console.log('time budget: ' + error)
    for (const warning of result.warnings) console.log('time budget (reported only): ' + warning)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (process.argv[2] === 'summary') {
    // One summary line: the time the run step recorded and its share of the job's limit in seconds (#1445).
    const limitMs = Number(process.argv[3]) * 1000
    if (!(limitMs > 0)) throw new Error('summary needs the job limit in seconds, such as 600')
    // The line only reports: whatever the timings file holds, or a summary file that cannot be written,
    // a job whose tests passed stays green, with a warning instead of the line.
    let line = null
    try {
      const timings = readBoardTimings()
      const totalMs = timings?.totalMs
      if (typeof totalMs !== 'number' || !Number.isFinite(totalMs) || totalMs < 0) throw new Error('the test timings have no run time')
      const part = typeof timings.part === 'string' && /^\d+\/\d+$/.test(timings.part) ? timings.part : '1/1'
      line = 'part ' + part + ': tests ran ' + seconds(totalMs) + 's, ' + Math.round(totalMs / limitMs * 100) + '% of the ' + seconds(limitMs) + 's job limit'
      console.log(line)
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- ' + line + '\n')
    } catch (error) {
      console.log(error?.code === 'ENOENT' && line === null ? 'no test timings recorded; no summary line' : '::warning::no summary line: ' + String(error?.message ?? error).replace(/\s+/g, ' '))
    }
    return
  }
  if (process.argv[2] === 'verify') {
    const result = checkResults(JSON.parse(process.env.CI_PLAN), JSON.parse(process.env.CI_RESULTS))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }
  if (process.argv[2] !== 'plan') throw new Error('use plan, run, check, summary or verify')
  const roots = JSON.parse(process.env.CI_SOURCE_ROOTS)
  const files = process.env.CI_CHANGED_FILES ? JSON.parse(process.env.CI_CHANGED_FILES) : process.env.CI_FORCE_FULL === 'true' ? [] : gitPaths(roots.at(-1), process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA)
  // The workflow's (system, Node) pairs (#1917); without them the planner names no matrices and test.yml keeps today's.
  const pairs = process.env.CI_NODE_PAIRS ? JSON.parse(process.env.CI_NODE_PAIRS) : undefined
  emitPlan(await buildPlan(files, { roots, forceFull: process.env.CI_FORCE_FULL === 'true', pairs }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

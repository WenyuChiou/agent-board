import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, appendFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_ENTRY, bundleFiles, isBundleFile } from './bundle-text.mjs'

export const GROUPS = ['board', 'messaging', 'tooling', 'npm', 'plugin', 'installers', 'remote', 'journeys', 'browser', 'generated']
const systems = ['ubuntu-latest', 'windows-latest']
const toolingTests = ['pr-check', 'preflight', 'changelog-fold', 'team-stats', 'review-queue'].map(name => 'tests/' + name + '.test.mjs')
const messagingTests = ['tests/exchange.test.mjs', 'tests/messaging.test.mjs']
const safePath = value => {
  if (typeof value !== 'string' || !value || /[\0\r\n\\:]/.test(value) || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid repository path')
  return value
}
const groupForTest = path => {
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
    if (['hooks/released.ts', 'tests/fixtures/released.ts', 'scripts/build-released.ts'].includes(path)) {
      generated.released = true
      select('generated', path)
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
    if (/^scripts\/(?:pr-check|preflight|changelog-fold|team-stats|review-queue)\.mjs$/.test(path)) { select('tooling', path); known = true }
    if (/^(?:scripts\/setup|tests\/setup\.check)\.(?:sh|ps1)$/.test(path)) {
      select('installers', path)
      installers.add(path.endsWith('.ps1') ? 'windows-latest' : 'ubuntu-latest')
      known = true
    }
    if (known) continue
    if (/^(?:README(?:\.[\w-]+)?\.md|CHANGELOG\.md|LICENSE|CODE_OF_CONDUCT\.md|SECURITY\.md)$/.test(path) || /^(?:docs|changelog\.d)\/.*\.(?:md|svg|png|jpg|webp|gif)$/.test(path)) continue
    full = true
    reasons.push({ group: 'full', path, reason: 'unclassified path' })
  }
  if (full) {
    for (const group of GROUPS) checks[group] = true
    generated.bundle = generated.released = true
  }
  if (checks.installers && (full || !installers.size || files.some(path => options.deps?.installers?.has(path) && !/^(?:scripts\/setup|tests\/setup\.check)\.(?:sh|ps1)$/.test(path)))) {
    for (const system of systems) installers.add(system)
  }
  // Generated verification is an independent job even when no product consumer changed.
  checks.generated ||= generated.bundle || generated.released
  return {
    version: 1, full, files, checks, testFiles, generated,
    installerMatrix: systems.filter(system => installers.has(system)),
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

// Keep literals as tokens so braces and helper names inside prose cannot become code.
const codeTokens = text => {
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

export const buildPlan = async (files, { roots, forceFull = false }) => {
  if (!Array.isArray(roots) || !roots.length) throw new Error('base and head source roots are required')
  const tests = Object.fromEntries(GROUPS.map(group => [group, []]))
  const deps = Object.fromEntries(GROUPS.map(group => [group, new Set()]))
  const bundleSources = new Set()
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
    for (const path of ['hooks/parse.ts', 'hooks/blocks.ts']) deps.remote.add(path)
    for (const path of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'docs/FORMAT.md']) deps.journeys.add(path)
    for (const path of ['hooks/register.tsx', 'hooks/hooks.json', 'types/index.d.ts']) {
      for (const dependency of await walkDependencies(root, [path])) deps.plugin.add(dependency)
    }
  }
  // Changes hidden behind the generated bundle affect every consumer of that bundle.
  for (const group of GROUPS) if ([...deps[group]].some(isBundleFile)) {
    for (const path of bundleSources) deps[group].add(path)
  }
  // Removed tests inform impact, but only existing head tests may be executed.
  const head = roots.at(-1)
  for (const group of GROUPS) tests[group] = tests[group].filter(path => existsSync(join(head, path))).sort()
  const plan = makePlan(files, { tests, deps, bundleSources, forceFull })
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
  const finalPlan = plan.full && notes.length ? makePlan(files, { tests, deps, bundleSources, forceFull: true }) : plan
  // Changed paths include deletions; runnable files must always come from the head.
  for (const group of GROUPS) finalPlan.testFiles[group] = finalPlan.testFiles[group].filter(path => existsSync(join(head, path)))
  return { ...finalPlan, notes }
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
    const output = { plan: JSON.stringify(plan), full: String(plan.full), installers_os: JSON.stringify(plan.installerMatrix.length ? plan.installerMatrix : systems) }
    for (const group of GROUPS) output[group] = String(plan.checks[group])
    for (const group of ['board', 'messaging', 'tooling', 'npm', 'journeys', 'browser']) output[group + '_tests'] = JSON.stringify(plan.testFiles[group])
    output.bundle = String(plan.generated.bundle)
    output.released = String(plan.generated.released)
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => key + '=' + value).join('\n') + '\n')
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '## Affected checks\n\n' + GROUPS.map(group => '- ' + group + ': ' + (plan.checks[group] ? 'selected' : 'not run (unaffected)')).join('\n') +
    '\n\nFull plan: ' + plan.full + '\n\nSoak recommended: ' + plan.soakRecommended + '\n\nChanged paths:\n' + plan.files.map(path => '- ' + path).join('\n') + '\n')
}

export const runTestFiles = files => {
  if (!Array.isArray(files) || !files.length || files.some(path => !/^tests\/(?:[\w-]+\/)*[\w.-]+\.test\.mjs$/.test(path) || !existsSync(path))) throw new Error('selected tests are empty, invalid or missing')
  const result = spawnSync(process.execPath, ['--test', ...(process.env.CI_TEST_SERIAL === '1' ? ['--test-concurrency=1'] : []), ...files], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('selected tests failed: ' + (result.status ?? result.signal))
}

const main = async () => {
  if (process.argv[2] === 'run') { runTestFiles(JSON.parse(process.env.CI_TEST_FILES)); return }
  if (process.argv[2] === 'verify') {
    const result = checkResults(JSON.parse(process.env.CI_PLAN), JSON.parse(process.env.CI_RESULTS))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }
  if (process.argv[2] !== 'plan') throw new Error('use plan, run or verify')
  const roots = JSON.parse(process.env.CI_SOURCE_ROOTS)
  const files = process.env.CI_CHANGED_FILES ? JSON.parse(process.env.CI_CHANGED_FILES) : process.env.CI_FORCE_FULL === 'true' ? [] : gitPaths(roots.at(-1), process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA)
  emitPlan(await buildPlan(files, { roots, forceFull: process.env.CI_FORCE_FULL === 'true' }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

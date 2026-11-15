// Fail-first: each test a pull request's case table names that is new or changed since the merge base runs twice,
// on a checkout of the merge base with the branch's tests copied in, where it should fail, and on the branch, where it
// should pass. A test that passes on both does not check the change (CONTRIBUTING rule 8, #1520).
// It imports nothing else from this repository, so another project can copy it and pass its own `runnerFor`.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const testFile = /^tests\/(?:.*\/)?[^/]+\.test\.(mjs|cjs|js|ts|tsx)$/
const titleCall = /(^|[^.\w$])(test|it)(?:\.(?:skip|only|todo))?\s*\(\s*('(?:\\[^\r\n]|[^'\\\r\n])*'|"(?:\\[^\r\n]|[^"\\\r\n])*"|`(?:\\[^\r\n]|[^`\\\r\n])*`)/gm
const topLevelCall = /^(?:test|it)(?:\.(?:skip|only|todo))?\s*\(/gm
const unescape = text => text.replace(/\\(.)/g, (_, char) => ({ n: '\n', t: '\t' })[char] ?? char)

// Every test title in a file, in order; a template title (`${…}`) cannot be run by its name.
export const titlesOf = text => [...text.matchAll(titleCall)].map(match => {
  const raw = match[3]
  const title = unescape(raw.slice(1, -1))
  return { title, isTemplate: raw[0] === '`' && /\$\{/.test(title) }
})

// The source of each top-level test, from its call at the start of a line to the next one, by title. A test whose
// source is the same on the base and here pins behaviour that was already there.
export const testBlocks = text => {
  const starts = [...text.matchAll(topLevelCall)].map(match => match.index)
  const blocks = new Map()
  starts.forEach((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length)
    const found = titlesOf(block)[0]
    if (found && !found.isTemplate && !blocks.has(found.title)) blocks.set(found.title, block.trimEnd())
  })
  return blocks
}

const count = (output, name) => Number(output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'))?.[1] ?? 0)
// A run reads as pass, fail, skipped, missing (the name matched no test) or stopped (no verdict: a time limit, a
// signal, a program that did not start).
export const outcomeOf = ran => {
  if (ran.error || ran.signal || ran.status === null || ran.status === undefined) return 'stopped'
  const output = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`
  const [tests, pass, fail, skipped] = ['tests', 'pass', 'fail', 'skipped'].map(name => count(output, name))
  if (ran.status !== 0 || fail > 0) return 'fail'
  if (pass > 0) return 'pass'
  if (skipped > 0) return 'skipped'
  return tests === 0 ? 'missing' : 'fail'
}

export const namePattern = title => `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
export const failFirstLine = ({ counted, total, base, head }) => `Fail-first: ${counted} of ${total} new or changed tests fail on ${base.slice(0, 8)} and pass on ${head.slice(0, 8)}.`

// How to run one test of a file, by exact name; null for a file this runner cannot run (here, plugin tests).
export const nodeRunner = path => /\.(mjs|cjs|js)$/.test(path)
  ? title => [process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', namePattern(title), path]]
  : null

const linesOf = text => text.split('\0').filter(Boolean)

// `command(program, args, options)` runs a program and returns spawnSync's result; `env` is the environment the tests
// get, or a function that returns a fresh one for each run. Returns each named title's state, how many were counted, the total that ran to a verdict and the line to paste.
export const runFailFirst = async ({ cwd, base, names, command, env, runnerFor = nodeRunner, timeout = 300000, onCheckout, onRun }) => {
  const big = 64 * 1024 * 1024
  const git = (...args) => {
    const ran = command('git', args, { cwd, maxBuffer: big })
    if (ran.error || ran.status !== 0) throw new Error(`git ${args[0]} failed`)
    return ran.stdout ?? ''
  }
  const head = git('rev-parse', 'HEAD').trim()
  const baseSha = git('rev-parse', '--verify', `${base}^{commit}`).trim()
  const tracked = linesOf(git('ls-files', '-z', '--', 'tests'))
  const untracked = linesOf(git('ls-files', '--others', '--exclude-standard', '-z', '--', 'tests'))
  const files = [...new Set([...tracked, ...untracked])].filter(path => testFile.test(path) && existsSync(join(cwd, path)))
  // Everything under tests/ that differs from the base (helpers and fixtures too), so the base run differs from the
  // run here only outside tests/.
  const copies = [...new Set([...linesOf(git('diff', '--name-only', '-z', baseSha, '--', 'tests')), ...untracked])].filter(path => existsSync(join(cwd, path)))
  const isDirty = git('status', '--porcelain', '-z').length > 0
  const textOf = path => readFileSync(join(cwd, path), 'utf8')
  const baseText = path => {
    const ran = command('git', ['show', `${baseSha}:${path}`], { cwd, maxBuffer: big })
    return ran.error || ran.status !== 0 ? null : ran.stdout
  }
  const owners = new Map()
  for (const path of files) for (const { title, isTemplate } of titlesOf(textOf(path))) if (!isTemplate) owners.set(title, [...(owners.get(title) ?? []), path])
  const results = []
  const toRun = []
  for (const title of [...new Set(names)]) {
    const paths = [...new Set(owners.get(title) ?? [])]
    if (/<[^<>]+>/.test(title)) results.push({ title, state: 'template' })
    else if (!paths.length) results.push({ title, state: 'unknown' })
    else if (paths.length > 1) results.push({ title, state: 'ambiguous', path: paths.join(', ') })
    else {
      const [path] = paths
      const was = baseText(path)
      if (was !== null && testBlocks(was).get(title) === testBlocks(textOf(path)).get(title) && testBlocks(textOf(path)).has(title)) results.push({ title, path, state: 'unchanged' })
      else if (!runnerFor(path)) results.push({ title, path, state: 'not-node' })
      else toRun.push({ title, path })
    }
  }
  const runOne = (where, { title, path }) => {
    const [program, args] = runnerFor(path)(title)
    onRun?.({ where, title, path })
    return outcomeOf(command(program, args, { cwd: where, env: typeof env === 'function' ? env() : env, timeout, maxBuffer: big }))
  }
  const here = new Map(toRun.map(item => [item.title, runOne(cwd, item)]))
  const needBase = toRun.filter(item => here.get(item.title) === 'pass')
  const onBase = new Map()
  if (needBase.length) {
    const temp = mkdtempSync(join(tmpdir(), 'fail-first-base-'))
    const checkout = join(temp, 'repo')
    try {
      git('worktree', 'add', '--detach', checkout, baseSha)
      onCheckout?.(checkout)
      // The branch's tests go into the base checkout; everything else stays as it was on the base.
      for (const path of copies) {
        mkdirSync(dirname(join(checkout, path)), { recursive: true })
        copyFileSync(join(cwd, path), join(checkout, path))
      }
      for (const item of needBase) onBase.set(item.title, runOne(checkout, item))
    } finally {
      const removed = command('git', ['worktree', 'remove', '--force', checkout], { cwd })
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      if (removed.error || removed.status !== 0) command('git', ['worktree', 'prune'], { cwd })
    }
  }
  for (const item of toRun) {
    const head = here.get(item.title)
    const was = onBase.get(item.title)
    const state = head === 'fail' ? 'fails-on-head'
      : head === 'skipped' ? 'skipped'
        : head === 'missing' ? 'missing'
          : head === 'stopped' ? 'stopped'
            : was === 'fail' ? 'counted'
              : was === 'pass' ? 'passes-on-base'
                : 'base-unknown'
    results.push({ ...item, state })
  }
  // Ran to a verdict, or was meant to and did not finish: these make the total; skipped, missing and unrunnable do not.
  const total = results.filter(item => ['counted', 'passes-on-base', 'fails-on-head', 'stopped', 'base-unknown'].includes(item.state)).length
  const counted = results.filter(item => item.state === 'counted').length
  const order = new Map([...new Set(names)].map((title, i) => [title, i]))
  results.sort((a, b) => order.get(a.title) - order.get(b.title))
  return { results, counted, total, base: baseSha, head, isDirty, line: total ? failFirstLine({ counted, total, base: baseSha, head }) : null }
}

// What each state means, for a line that names the test.
export const stateWords = {
  counted: 'fails on the base and passes here',
  'passes-on-base': 'passes on the base too, so it does not check this change',
  'fails-on-head': 'fails here',
  'base-unknown': 'gave no verdict on the base',
  stopped: 'did not finish',
  skipped: 'is skipped on this system; not counted',
  missing: 'matched no test by its exact name; not counted',
  unchanged: 'is unchanged since the base; not run',
  'not-node': 'is not a Node test file here (a plugin test runs with `claude plugin test`); not counted',
  template: 'is a template title; not run',
  unknown: 'is not a test title in tests/; not counted',
  ambiguous: 'is a title in more than one file; not run',
}

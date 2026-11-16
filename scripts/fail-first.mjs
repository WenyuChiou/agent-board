// Fail-first: each test a pull request's case table names runs on the branch, where it should pass, and then on a
// checkout of the merge base with the branch's tests copied in, where it should fail. A test that passes on both does not check the change (CONTRIBUTING rule 8, #1520).
// It imports nothing else from this repository, so another project can copy it and pass its own `runnerFor`.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const testFile = /^tests\/(?:.*\/)?[^/]+\.test\.(mjs|cjs|js|ts|tsx)$/
// The reader pr-check uses for test titles: every `test(…)` or `it(…)` call with a literal title, at any depth. It keeps
// no state from one call to the next, so no code earlier in a file can hide a later title. It also reads a call inside a
// string, a comment or a method call (`pattern.test('x')`); running the title settles those, since it runs no test.
const titleCall = /\b(?:test|it)(?:\.(?:skip|only|todo))?\s*\(\s*('(?:\\[^\r\n]|[^'\\\r\n])*'|"(?:\\[^\r\n]|[^"\\\r\n])*"|`(?:\\[^\r\n]|[^`\\\r\n])*`)/g
// Exact source-spelling parity with scripts/pr-check.mjs (`unescapeTitle`): quotes and backslashes unescape, while
// `\t`, `\n`, ... stay in source form so case-table spans match; runtime unescaping happens only when running (#1541).
const unescapeSource = text => text.replace(/\\(['"\\`])/g, '$1')
const unescapeRuntime = text => text.replace(/\\(.)/g, (_, char) => ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' })[char] ?? char)
const parsedTitleOf = raw => {
  const inner = raw.slice(1, -1)
  const title = unescapeSource(inner)
  return { title, runtime: unescapeRuntime(inner), isTemplate: raw[0] === '`' && /\$\{/.test(title) }
}
const parsedTitlesOf = text => [...text.matchAll(titleCall)].map(match => parsedTitleOf(match[1]))

// Every test title in a file, in order; a template title (`${…}`) cannot be run by its name.
export const titlesOf = text => parsedTitlesOf(text).map(({ title, isTemplate }) => ({ title, isTemplate }))

const count = (output, name) => Number(output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'))?.[1] ?? 0)
// Each result line of a TAP report, at any depth: `not `, the name (Node escapes `\` and `#` in it) and a SKIP or TODO.
const tapLine = /^[ \t]*(not )?ok \d+ - ((?:\\.|[^\\#\r\n])*?)[ \t]*(?:#[ \t]*(SKIP|TODO)\b[^\r\n]*)?\r?$/gim
const tapName = text => text.replace(/\\(.)/g, (_, char) => ({ n: '\n', t: '\t', r: '\r' })[char] ?? char)
// Node's TAP reporter escapes control characters before escaping `\`, turning `\t` into `\\t` in TAP lines (#1541).
const matchesTapName = (raw, title) => {
  const once = tapName(raw)
  return once.trimEnd() === title.trimEnd() || tapName(once).trimEnd() === title.trimEnd()
}
// A run reads as pass, fail, skipped, todo, missing (the name matched no test) or stopped (no verdict: a time limit, a
// signal, a program that did not start). With the title, a pass needs the test's own result line: a name that matches no
// test still exits 0, and Node then reports the file itself as one passing test. A todo result never fails a run, so it
// is neither pass nor fail. The output is read, not proved: a test file can print such a line itself, and the
// `Fail-first:` line is pasted by hand anyway.
export const outcomeOf = (ran, title) => {
  if (ran.error || ran.signal || ran.status === null || ran.status === undefined) return 'stopped'
  const output = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`
  const [tests, pass, fail, skipped] = ['tests', 'pass', 'fail', 'skipped'].map(name => count(output, name))
  if (ran.status !== 0 || fail > 0) return 'fail'
  if (title !== undefined) {
    // TAP drops the spaces at the end of a name.
    const named = [...output.matchAll(tapLine)].filter(match => matchesTapName(match[2], title))
    if (!named.length) return 'missing'
    if (named.some(match => match[1] && !match[3])) return 'fail'
    if (named.some(match => !match[3])) return 'pass'
    return named.some(match => match[3].toUpperCase() === 'TODO') ? 'todo' : 'skipped'
  }
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
// get, or a function that returns a fresh one for each run. Returns each named title's state, how many were counted, the total and the line to paste.
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
  // Everything under tests/ that differs from the base (helpers and fixtures too, and files the branch deleted or
  // renamed: --no-renames lists a rename's old path too), so the base run differs from the run here only outside tests/.
  const differs = [...new Set([...linesOf(git('diff', '--name-only', '--no-renames', '-z', baseSha, '--', 'tests')), ...untracked])]
  const copies = differs.filter(path => existsSync(join(cwd, path)))
  const deleted = differs.filter(path => !existsSync(join(cwd, path)))
  const isDirty = git('status', '--porcelain', '-z').length > 0
  const textOf = path => readFileSync(join(cwd, path), 'utf8')
  const owners = new Map()
  for (const path of files) for (const { title, runtime, isTemplate } of parsedTitlesOf(textOf(path))) if (!isTemplate) owners.set(title, [...(owners.get(title) ?? []), { path, runtime }])
  const runOne = (where, { title, runtime = title, path }) => {
    const [program, args] = runnerFor(path)(runtime)
    onRun?.({ where, title, path })
    return outcomeOf(command(program, args, { cwd: where, env: typeof env === 'function' ? env() : env, timeout, maxBuffer: big }), runtime)
  }
  // Every named test that passes here runs on the base, whatever its file: neither a file the branch left as it was nor
  // any source text makes a test old, since a helper or fixture it reads may have changed (#1532).
  const results = []
  const toRun = []
  const here = new Map()
  for (const title of [...new Set(names)]) {
    const entries = [...new Map((owners.get(title) ?? []).map(entry => [`${entry.path}\0${entry.runtime}`, entry])).values()]
    const paths = [...new Set(entries.map(entry => entry.path))]
    // Look up an exact fixed title before checking `<...>` so literal angle brackets in fixed titles still run (#1542).
    if (!entries.length) { results.push({ title, state: /<[^<>]+>/.test(title) ? 'template' : 'unknown' }); continue }
    let [entry] = entries
    if (entries.length > 1) {
      // The reader also finds a title in a string, a comment or a method call, so the file that has the test is the one
      // whose run finds it by name; a file this runner cannot run cannot be ruled out.
      const found = []
      for (const candidate of entries) {
        if (!runnerFor(candidate.path)) { found.push({ candidate }); continue }
        const outcome = runOne(cwd, { title, runtime: candidate.runtime, path: candidate.path })
        if (outcome !== 'missing') found.push({ candidate, outcome })
      }
      if (found.length !== 1) { results.push({ title, state: found.length ? 'ambiguous' : 'missing', path: paths.join(', ') }); continue }
      entry = found[0].candidate
      if (found[0].outcome) here.set(title, found[0].outcome)
    }
    if (!runnerFor(entry.path)) results.push({ title, path: entry.path, state: 'not-node' })
    else toRun.push({ title, runtime: entry.runtime, path: entry.path })
  }
  // Every named test runs here first, so a title that is no test shows as missing wherever it is written.
  for (const item of toRun) if (!here.has(item.title)) here.set(item.title, runOne(cwd, item))
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
      for (const path of deleted) rmSync(join(checkout, path), { force: true })
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
        : head === 'todo' ? 'todo'
          : head === 'missing' ? 'missing'
            : head === 'stopped' ? 'stopped'
                : was === 'fail' ? 'counted'
                  : was === 'pass' ? 'passes-on-base'
                    : 'base-unknown'
    results.push({ title: item.title, path: item.path, state })
  }
  // Every title found in tests/ makes the total except a test skipped on this system, a todo test and a file this runner
  // cannot run; one that no run finds by its name, that tests/ lacks altogether (#1541), or that more than one file
  // has, counts against it.
  const total = results.filter(item => ['counted', 'passes-on-base', 'fails-on-head', 'stopped', 'base-unknown', 'missing', 'unknown', 'ambiguous'].includes(item.state)).length
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
  todo: 'is a todo test, which no run can fail; not counted',
  missing: 'matched no test by its exact name',
  'not-node': 'is not a Node test file here (a plugin test runs with `claude plugin test`); not counted',
  template: 'is a template title; not run',
  unknown: 'is not a test title in tests/',
  ambiguous: 'is a test in more than one file, so it cannot be run by its name alone',
}

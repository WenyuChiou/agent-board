import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addedLines } from './pr-check.mjs'

// Grep-level rules over the lines a pull request adds (#1546). A correction that used to be a bullet in team-process
// becomes a rule here: add an object to `rules`, with the error that names its cause and the fix, and a failing and a
// passing case in tests/code-rules.test.mjs. Only added lines are read, so a line already on main never blocks.
//
// The lists the rules use are data in scripts/code-rules.json, read from the pull request's checkout (`--repo-dir`),
// so a pull request can add its own entry in the same change. The checker itself still comes from the base branch:
// nothing the pull request wrote is imported or run, only that JSON is read.

const here = dirname(fileURLToPath(import.meta.url))
export const CONFIG_PATH = 'scripts/code-rules.json'

// The pull request's list, or this checker's own when the checkout has none because its branch was cut before the file
// existed. When `refs` names the base and head and the merge base already had the list, the pull request removed it:
// that stops the check instead of falling back, so a deleted list never passes (round 2 of #1551).
export const loadConfig = (repoDir = process.cwd(), refs) => {
  const own = join(resolve(repoDir), CONFIG_PATH)
  if (!existsSync(own) && refs) {
    const { base = 'origin/main', head = 'HEAD', run = spawnSync } = refs
    const mergeBase = run('git', ['merge-base', base, head], { cwd: repoDir, encoding: 'utf8' })
    if (mergeBase.error || mergeBase.status !== 0) throw new Error(`code-rules: ${CONFIG_PATH} is missing and git could not find the merge base of ${base} and ${head}; fetch the base and run again.`)
    // ls-tree prints the path when the merge base has it and nothing when not; any failure stops the check (codex_448).
    const had = run('git', ['ls-tree', '--name-only', mergeBase.stdout.trim(), '--', CONFIG_PATH], { cwd: repoDir, encoding: 'utf8' })
    if (had.error || had.status !== 0) throw new Error(`code-rules: ${CONFIG_PATH} is missing and git could not read the merge base; fetch the base and run again.`)
    if (had.stdout.trim()) throw new Error(`code-rules: this pull request removes ${CONFIG_PATH}; restore it from main (the check reads its list from the pull request).`)
  }
  const path = existsSync(own) ? own : join(here, 'code-rules.json')
  let config
  try { config = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error(`code-rules: ${CONFIG_PATH} is not readable JSON; fix it or restore it from main.`) }
  if (!Array.isArray(config?.setTimeoutFiles) || config.setTimeoutFiles.some(item => typeof item !== 'string')) {
    throw new Error(`code-rules: ${CONFIG_PATH} must be {"setTimeoutFiles": ["hooks/..."]}; fix it or restore it from main.`)
  }
  return config
}

// hooks/board-script-N.ts are built from other sources; the rule reads the sources.
const isGenerated = path => /^hooks\/board-script-\d+\.ts$/.test(path)

// Every added line is read whole, its comments and strings included. A line alone does not say whether it starts
// inside a comment, a string or a template literal opened on a line above, so a reader that drops comments and strings
// can drop a real call (rounds 2 to 5 of #1551). Reading the whole line never misses one; the cost is that the word in
// a comment or a string fails too, and the fix says how to word it instead.
const TEXT_ONLY = 'If the word is only text in a comment or a string, reword it or split it'

export const rules = [
  {
    id: 'set-timeout-in-hooks',
    applies: (path, config) => /^hooks\/.+\.tsx?$/.test(path) && !isGenerated(path) && !config.setTimeoutFiles.includes(path),
    test: text => /\bsetTimeout\b/.test(text),
    cause: 'a new `setTimeout` (a call, or the function passed on) in a hooks/ file that is not on the list of files that already use one: a timer in a hook keeps the hook process alive after its work is done or fires after the agent moved on.',
    fix: `start the timer from a file already on the list, or add this file to "setTimeoutFiles" in ${CONFIG_PATH} in the same pull request and say why in its body (the check reads the list from the pull request). For a renamed or moved file, move its path in that list. ${TEXT_ONLY} ('set' + 'Timeout', or "a timer").`,
  },
  {
    id: 'only-in-tests',
    applies: path => /^tests\/.+\.test\.(?:mjs|tsx?)$/.test(path),
    test: text => /\b(?:test|describe|it)\.only\b/.test(text),
    cause: 'a committed `.only(`: node and the test runners then skip every other test in the file, and the run still passes.',
    fix: `remove \`.only\` before committing; run one test with \`--test-name-pattern\` instead. ${TEXT_ONLY} (build it as 'it' + ONLY, with const ONLY = '.only').`,
  },
]

// The failures for a list of `{ path, line, text }` added lines.
export const checkAdded = (added, config = loadConfig(), list = rules) => added.flatMap(item => list
  .filter(rule => rule.applies(item.path, config) && rule.test(item.text))
  .map(rule => ({ rule: rule.id, path: item.path, line: item.line, message: `${item.path}:${item.line}: [${rule.id}] ${rule.cause} Fix: ${rule.fix}` })))

export const diffAdded = ({ cwd = process.cwd(), base = 'origin/main', head = 'HEAD', run = spawnSync } = {}) => {
  const diff = run('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', `${base}...${head}`], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (diff.error || diff.status !== 0) throw new Error(`code-rules: git could not read ${base}...${head}; fetch the base and run again.`)
  return addedLines(diff.stdout)
}

export const main = (argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) => {
  const value = name => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
  try {
    const cwd = resolve(value('--repo-dir') ?? '.')
    const refs = { base: value('--base') ?? 'origin/main', head: value('--head') ?? 'HEAD' }
    const failures = checkAdded(diffAdded({ cwd, ...refs }), loadConfig(cwd, refs))
    if (!failures.length) { log('code-rules: PASS, no added line breaks a code rule.'); return 0 }
    for (const failure of failures) error(`FAIL ${failure.message}`)
    error(`code-rules: ${failures.length} FAIL`)
    return 1
  } catch (problem) { error(problem.message); return 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()

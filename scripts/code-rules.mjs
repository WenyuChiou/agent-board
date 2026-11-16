import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addedLines } from './pr-check.mjs'

// Grep-level rules over the lines a pull request adds (#1546). A correction that used to be a bullet in team-process
// becomes a rule here: add an object to `rules`, with the error that names its cause and the fix, and a failing and a
// passing case in tests/code-rules.test.mjs. Only added lines are read, so a line already on main never blocks.

// Files in hooks/ that already start a timer with setTimeout. A new file does not join the list by being added: it
// is added here by the pull request that needs it, with the reason in its body.
export const SET_TIMEOUT_FILES = [
  'hooks/antigravity-sidecar.ts', 'hooks/board-dock.ts', 'hooks/hook-safety.ts', 'hooks/local-agents.ts',
  'hooks/page-look.ts', 'hooks/portable-agents.ts', 'hooks/receivers/deepseek.ts', 'hooks/receivers/opencode.ts',
  'hooks/serve.ts',
]

// hooks/board-script-N.ts are built from other sources; the rule reads the sources.
const isGenerated = path => /^hooks\/board-script-\d+\.ts$/.test(path)
const isComment = text => /^\s*(?:\/\/|\*|\/\*)/.test(text)

export const rules = [
  {
    id: 'set-timeout-in-hooks',
    applies: path => /^hooks\/.+\.tsx?$/.test(path) && !isGenerated(path) && !SET_TIMEOUT_FILES.includes(path),
    test: text => !isComment(text) && /\bsetTimeout\s*\(/.test(text),
    cause: 'a new `setTimeout(` in a hooks/ file that is not on the list of files that already use one: a timer in a hook keeps the hook process alive after its work is done or fires after the agent moved on.',
    fix: 'start the timer from a file already on the list, or, if this file needs its own, add it to SET_TIMEOUT_FILES in scripts/code-rules.mjs and say why in the pull request body.',
  },
  {
    id: 'only-in-tests',
    applies: path => /^tests\/.+\.test\.(?:mjs|tsx?)$/.test(path),
    test: text => !isComment(text) && /^\s*(?:test|describe|it)\.only\s*\(/.test(text),
    cause: 'a committed `.only(`: node and the test runners then skip every other test in the file, and the run still passes.',
    fix: 'remove `.only` before committing; run one test with `--test-name-pattern` instead.',
  },
]

// The failures for a list of `{ path, line, text }` added lines.
export const checkAdded = (added, list = rules) => added.flatMap(item => list
  .filter(rule => rule.applies(item.path) && rule.test(item.text))
  .map(rule => ({ rule: rule.id, path: item.path, line: item.line, message: `${item.path}:${item.line}: [${rule.id}] ${rule.cause} Fix: ${rule.fix}` })))

export const diffAdded = ({ cwd = process.cwd(), base = 'origin/main', head = 'HEAD', run = spawnSync } = {}) => {
  const diff = run('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', `${base}...${head}`], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (diff.error || diff.status !== 0) throw new Error(`code-rules: git could not read ${base}...${head}; fetch the base and run again.`)
  return addedLines(diff.stdout)
}

export const main = (argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) => {
  const value = name => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
  try {
    const failures = checkAdded(diffAdded({ cwd: resolve(value('--repo-dir') ?? '.'), base: value('--base'), head: value('--head') }))
    if (!failures.length) { log('code-rules: PASS, no added line breaks a code rule.'); return 0 }
    for (const failure of failures) error(`FAIL ${failure.message}`)
    error(`code-rules: ${failures.length} FAIL`)
    return 1
  } catch (problem) { error(problem.message); return 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()

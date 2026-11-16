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
const isBlockCommentLine = text => /^\s*\*/.test(text)

// The index of the `}` that closes a `${` expression whose body starts at `from`, past strings, comments and nested
// templates, so a quoted brace neither ends the expression early nor keeps it open (codex_448); the line's length when
// it does not close on this line.
const closeOf = (text, from) => {
  let depth = 1
  for (let k = from; k < text.length; k++) {
    const c = text[k]
    if (c === '\\') k++
    else if (c === '"' || c === "'") { k++; while (k < text.length && text[k] !== c) k += text[k] === '\\' ? 2 : 1 }
    else if (c === '`') k = templateEnd(text, k)
    else if (c === '/' && text[k + 1] === '/') return text.length
    else if (c === '/' && text[k + 1] === '*') { const end = text.indexOf('*/', k + 2); if (end === -1) return text.length; k = end + 1 }
    else if (c === '/') throw AMBIGUOUS
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return k
  }
  return text.length
}
// The index of the backtick that closes the template starting at `start`, or the line's length.
const templateEnd = (text, start) => {
  let j = start + 1
  while (j < text.length && text[j] !== '`') {
    if (text[j] === '\\') j += 2
    else if (text[j] === '$' && text[j + 1] === '{') j = closeOf(text, j + 2) + 1
    else j++
  }
  return j
}

// A `/` in code that starts no comment is a regular expression or a division. This reader does not parse regular
// expressions, whose quotes and braces would mislead it, so such a line is read whole: the strict side (codex_450).
const AMBIGUOUS = Symbol('ambiguous')

// The line without its strings and comments, so a call inside a string, a `// ...` tail or a `/* ... */` never matches.
// A template literal's `${...}` expressions run, so they stay as code (round 2 of #1551). A line this reader cannot
// take apart (a regular expression, or nesting too deep for it) is returned whole, so a timer in it still fails.
export const codeOnly = text => {
  try { return strip(text) } catch { return text }
}
const strip = text => {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '/' && text[i + 1] === '/') break
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 1
      out += ' '
    } else if (char === '`') {
      let j = i + 1
      out += '`'
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '$' && text[j + 1] === '{') {
          const k = closeOf(text, j + 2)
          out += ` ${strip(text.slice(j + 2, k))} `
          j = k + 1
          continue
        }
        j++
      }
      out += '`'
      i = j
    } else if (char === '"' || char === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== char) j += text[j] === '\\' ? 2 : 1
      out += char + char
      i = j
    } else if (char === '/') throw AMBIGUOUS
    else out += char
  }
  return out
}

export const rules = [
  {
    id: 'set-timeout-in-hooks',
    applies: (path, config) => /^hooks\/.+\.tsx?$/.test(path) && !isGenerated(path) && !config.setTimeoutFiles.includes(path),
    test: text => !isBlockCommentLine(text) && /\bsetTimeout\b/.test(codeOnly(text)),
    cause: 'a new `setTimeout` (a call, or the function passed on) in a hooks/ file that is not on the list of files that already use one: a timer in a hook keeps the hook process alive after its work is done or fires after the agent moved on.',
    fix: `start the timer from a file already on the list, or add this file to "setTimeoutFiles" in ${CONFIG_PATH} in the same pull request and say why in its body (the check reads the list from the pull request). For a renamed or moved file, move its path in that list.`,
  },
  {
    id: 'only-in-tests',
    applies: path => /^tests\/.+\.test\.(?:mjs|tsx?)$/.test(path),
    test: text => !isBlockCommentLine(text) && /\b(?:test|describe|it)\.only\b/.test(codeOnly(text)),
    cause: 'a committed `.only(`: node and the test runners then skip every other test in the file, and the run still passes.',
    fix: 'remove `.only` before committing; run one test with `--test-name-pattern` instead.',
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

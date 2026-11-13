// Runs the plugin test files two at a time. `claude plugin test .` starts min(files, CPUs) children, so on a
// 4-vCPU runner four pane test files share the CPU. The suspected cause of the 5 s per-test limit tripping
// (#697, #1079) is that pane tests run slower then; neither that slowdown nor contention versus a lighter tail of
// tests is proven, and running two files at once is expected, not shown, to help. No test, limit or timeout is changed
// here, and nothing is retried or skipped.
// Usage: node scripts/plugin-tests.mjs [test file ...]   (no arguments: every *.test.ts and *.test.tsx under the
// current folder, as `claude plugin test --help` says the kit does; node_modules and .git are skipped)
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AT_ONCE = 2
// Letters and digits of any script, space and _ . / - ( ) only: on Windows the name goes inside double quotes to a
// shell, where these stay literal; a quote, %, !, ^, &, |, <, > or ; would not, so such a name is refused.
export const SAFE_NAME = /^[\p{L}\p{N} _./()-]+$/u
const REPORT = 'claude-plugin-test-report '

export const listTestFiles = (root = '.', dir = '') => {
  const found = []
  for (const entry of readdirSync(dir ? `${root}/${dir}` : root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...listTestFiles(root, path))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found.sort()
}

// Runs `run(file)` for each file with at most `limit` in flight; `onDone(file, result)` fires as each finishes.
export const runPool = async (files, run, { limit = AT_ONCE, onDone = () => {} } = {}) => {
  const results = []
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]
      const result = await run(file)
      results.push({ file, ...result })
      onDone(file, result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker))
  return results
}

// How one file's child starts. Windows needs a shell for the claude .cmd shim, and the name goes in double quotes so
// a space keeps it one argument; elsewhere the arguments reach the program as they are, with no shell.
export const childCommand = (file, command = 'claude', platform = process.platform) => {
  const args = ['plugin', 'test', '--file', file, '.']
  return platform === 'win32'
    ? { command: `${command} plugin test --file "${file}" .`, shell: true }
    : { command, args, shell: false }
}

// The names reach a shell on Windows, so anything outside the safe set is refused first, and counts as a failure.
export const runChild = (file, command = 'claude', platform = process.platform) =>
  new Promise(done => {
    if (!SAFE_NAME.test(file)) return done({ code: 1, output: `plugin-tests: refusing test file name ${JSON.stringify(file)}: only letters, digits, space and _ . / - ( ) are allowed\n` })
    const one = childCommand(file, command, platform)
    const child = one.shell
      ? spawn(one.command, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(one.command, one.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => done({ code: 1, output: `${output}${error.message}\n` }))
    child.on('close', code => done({ code: code ?? 1, output }))
  })

const sameFile = (a, b) => typeof a === 'string' && a.replace(/\\/g, '/').replace(/^\.\//, '') === b.replace(/^\.\//, '')

// Why a finished child does not count as a pass, or null. Exit 0 alone is not enough: the report must be there,
// whole, for this file, with every test passed.
export const failureReason = (file, { code, output }) => {
  if (code !== 0) return `exit ${code}`
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(REPORT))
  if (!lines.length) return 'no test report in the output'
  for (const line of lines) {
    let report
    try { report = JSON.parse(line.slice(REPORT.length)) } catch { return 'test report is not valid JSON (cut off?)' }
    if (!sameFile(report?.file, file)) return `test report is for ${JSON.stringify(report?.file)}, not this file`
    if (!Array.isArray(report.results) || !report.results.length) return 'test report has no results'
    // Every entry must be a result object that names its test (a non-empty title) and whose failure is null; a
    // missing, unnamed or malformed entry is a failure too.
    const named = result => result !== null && typeof result === 'object' && typeof result.title === 'string' && result.title !== ''
    const bad = report.results.findIndex(result => !named(result) || result.failure !== null)
    if (bad !== -1) return `test failed: ${named(report.results[bad]) ? report.results[bad].title : `result ${bad + 1} is malformed`}`
  }
  return null
}

export const main = async (argv = process.argv.slice(2), run = runChild) => {
  const files = argv.length ? argv : listTestFiles()
  if (!files.length) {
    console.error('plugin-tests: no test files found')
    return 1
  }
  const started = Date.now()
  const results = await runPool(files, run, {
    onDone: (file, result) => {
      const reason = failureReason(file, result)
      process.stdout.write(`${result.output.endsWith('\n') ? result.output : `${result.output}\n`}${reason ? `plugin-tests: FAILED ${file} (${reason})\n` : ''}`)
    },
  })
  const failed = results.filter(result => failureReason(result.file, result) !== null)
  console.log(`plugin-tests: ${results.length - failed.length}/${results.length} files passed, ${AT_ONCE} at a time, ${((Date.now() - started) / 1000).toFixed(1)} s${failed.length ? `; failed: ${failed.map(r => r.file).join(', ')}` : ''}`)
  return failed.length ? 1 : 0
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exitCode = await main()
}

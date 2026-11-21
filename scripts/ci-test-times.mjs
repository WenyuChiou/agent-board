import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Writes tests/ci-test-times.json from the logs of GitHub Actions jobs (#1762). scripts/ci-impact.mjs reads that table to
// deal the tests of the self-parted files out to the parts by time, and to weigh each other file.
//
//   node scripts/ci-test-times.mjs <job log>...
//
// Give it the logs of every Windows board job and every Windows local exchange job of one main run (a log for each part,
// Node 22 and 24 both: the faster of an item's times is kept, so a slow runner does not inflate the table). Fetch a log
// with `gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs`. Refresh the table, in the pull request that does it, when
// a pull request adds or removes many tests or a test file: from the logs of the newest main run, or of the pull request's
// own run once it is green. `--deal-from <module>` names another copy of scripts/ci-impact.mjs to read the files of each
// part from, for logs of a run that used the earlier dealing of files to parts.

export const TABLE_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tests', 'ci-test-times.json')

const unescapeTap = title => title.replace(/\\([\\#])/g, '$1')
const MS = '(\\d+(?:\\.\\d+)?)'
const skipped = /\s#\s(?:SKIP|TODO)\b.*$/

// The top-level tests and the times of each Node run in a job log, in the order they ran: its own total, and its wall time,
// which also holds the start of Node and the loading of the file. Node 22 prints TAP and Node 24
// the spec form; nested tests sit inside their parent's time, so only the unindented lines count. A run ends at its summary.
export const parseRuns = text => {
  const stamped = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line) ?? [line, '', line])
  const lines = stamped.map(parts => parts[2])
  const runs = []
  let tests = []
  // The runs start where the step's environment block ends: its time less the end of the last run is the wall time of a run.
  const envAt = lines.findIndex(line => /^\s*CI_TEST_FILES: \[/.test(line))
  let previousEnd = null
  for (let i = Math.max(envAt, 0); i < lines.length && previousEnd === null; i++) if (/^##\[endgroup\]/.test(lines[i])) previousEnd = Date.parse(stamped[i][1])
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let found
    if ((found = /^(?:not )?ok \d+ - (.*)$/.exec(line))) {
      let ms = null
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const duration = new RegExp('^  duration_ms: ' + MS + '$').exec(lines[j])
        if (duration) { ms = Number(duration[1]); break }
        if (/^\S/.test(lines[j])) break
      }
      const isSkipped = skipped.test(found[1])
      if (ms !== null) tests.push({ title: unescapeTap(found[1].replace(skipped, '')), ms, isSkipped })
    } else if ((found = new RegExp('^([✔✖﹣]) (.*?) \\(' + MS + 'ms\\)(?:\\s#\\s.*)?$').exec(line))) {
      tests.push({ title: found[2], ms: Number(found[3]), isSkipped: found[1] === '﹣' })
    } else if ((found = new RegExp('^(?:# |ℹ )duration_ms ' + MS + '$').exec(line))) {
      const end = Date.parse(stamped[i][1])
      runs.push({ tests, totalMs: Number(found[1]), wallMs: Number.isFinite(end) && previousEnd !== null ? end - previousEnd : null })
      previousEnd = Number.isFinite(end) ? end : previousEnd
      tests = []
    }
  }
  return runs
}

// A job's part, files and whether it ran one file at a time, from the environment lines the step prints.
export const parseJob = (text, name = '') => {
  const plain = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''))
  const filesLine = plain.find(line => /^\s*CI_TEST_FILES: \[/.test(line))
  if (!filesLine) throw new Error(name + ': no CI_TEST_FILES line')
  const files = JSON.parse(filesLine.replace(/^\s*CI_TEST_FILES: /, ''))
  const partLine = plain.find(line => /^\s*CI_TEST_PART: \d+\/\d+\s*$/.test(line))
  const part = partLine ? partLine.replace(/^\s*CI_TEST_PART: /, '').trim() : (/part (\d+\/\d+)/.exec(name) ?? [])[1]
  if (!part) throw new Error(name + ': no CI_TEST_PART line or part in the job name')
  return { part, files, isSerial: plain.some(line => /^\s*CI_TEST_SERIAL: 1\s*$/.test(line)) }
}

const squash = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/g, '')

// The items of one job log: the total of each file and the time of each top-level test of a self-parted file. A serial run has
// one Node run for each file, in partFiles order. Any other run has one Node run for all its files, so a test belongs to the
// self-parted file whose source holds its title (read with readSource).
export const readJob = (text, { name, partFiles, selfPartedTests, readSource }) => {
  const job = parseJob(text, name)
  const runs = parseRuns(text)
  const items = { files: {}, tests: {} }
  const add = (title, ms, seen) => {
    seen[title] = (seen[title] ?? 0) + 1
    return { key: seen[title] === 1 ? title : title + ' #' + seen[title], ms }
  }
  if (job.isSerial) {
    const filesOfRun = partFiles(job.files, job.part)
    if (runs.length !== filesOfRun.length) throw new Error(name + ': ' + runs.length + ' test runs in the log, ' + filesOfRun.length + ' files in the part ' + job.part)
    filesOfRun.forEach((file, i) => {
      const run = runs[i]
      if (!selfPartedTests.includes(file)) { items.files[file] = run.wallMs ?? run.totalMs; return }
      const seen = {}
      items.tests[file] = {}
      for (const test of run.tests) {
        const { key, ms } = add(test.title, test.ms, seen)
        if (!test.isSkipped) items.tests[file][key] = ms
      }
    })
    return items
  }
  const owners = Object.fromEntries(selfPartedTests.filter(file => job.files.includes(file)).map(file => [file, squash(readSource(file))]))
  const seenOf = {}
  for (const run of runs) for (const test of run.tests) {
    const file = Object.keys(owners).find(path => owners[path].includes(squash(test.title)))
    if (!file) continue
    seenOf[file] ??= {}
    items.tests[file] ??= {}
    const { key, ms } = add(test.title, test.ms, seenOf[file])
    if (!test.isSkipped) items.tests[file][key] = ms
  }
  return items
}

const sorted = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]))

// The table of the smallest time of every item over the jobs. A self-parted file's total is the sum of its tests.
export const buildTable = jobItems => {
  const files = {}
  const tests = {}
  for (const items of jobItems) {
    for (const [file, ms] of Object.entries(items.files)) files[file] = Math.min(files[file] ?? Infinity, ms)
    for (const [file, own] of Object.entries(items.tests)) for (const [key, ms] of Object.entries(own)) {
      tests[file] ??= {}
      tests[file][key] = Math.min(tests[file][key] ?? Infinity, ms)
    }
  }
  for (const file of Object.keys(tests)) {
    tests[file] = sorted(Object.fromEntries(Object.entries(tests[file]).map(([key, ms]) => [key, Math.round(ms)])))
    files[file] = Object.values(tests[file]).reduce((sum, ms) => sum + ms, 0)
  }
  return { version: 1, files: sorted(Object.fromEntries(Object.entries(files).map(([file, ms]) => [file, Math.round(ms)]))), tests: sorted(tests) }
}

const main = async () => {
  const args = process.argv.slice(2)
  const at = args.indexOf('--deal-from')
  const dealFrom = at === -1 ? join(dirname(fileURLToPath(import.meta.url)), 'ci-impact.mjs') : resolve(args.splice(at, 2)[1])
  if (!args.length) throw new Error('usage: node scripts/ci-test-times.mjs [--deal-from <ci-impact.mjs>] <job log>...')
  const { partFiles, selfPartedTests } = await import(pathToFileURL(dealFrom).href)
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const readSource = file => readFileSync(join(root, file), 'utf8')
  const table = buildTable(args.map(path => readJob(readFileSync(path, 'utf8'), { name: path, partFiles, selfPartedTests, readSource })))
  writeFileSync(TABLE_PATH, JSON.stringify(table, null, 2) + '\n')
  const count = Object.values(table.tests).reduce((sum, own) => sum + Object.keys(own).length, 0)
  console.log('wrote ' + TABLE_PATH + ': ' + Object.keys(table.files).length + ' files, ' + count + ' tests of ' + Object.keys(table.tests).length + ' self-parted files, from ' + args.length + ' logs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

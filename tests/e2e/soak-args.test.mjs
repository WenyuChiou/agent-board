import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'
import { OUT_DEFAULT, fileOpsPerPoll, makeRedact, median, parseArguments, peakRss, percentile, redactDeep, tallyOf, writeReport } from './lib/soak-report.mjs'

const soak = fileURLToPath(new URL('./soak.mjs', import.meta.url))

// One soak command line in a world, to the end: what it printed and how it exited.
const attempt = (world, args) => new Promise((resolve, reject) => {
  const child = spawnIsolated(process.execPath, [soak, ...args], { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => child.kill(), 15000)
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr, args }) })
})

describe('L6 soak arguments', () => {
  test('L6 soak arguments: a rejected --minutes value, a repeated flag and an unknown flag exit 2 with one plain line and create no report folder', async () => {
    const world = makeWorld()
    try {
      const before = readdirSync(world.root).sort()
      // Three whole runs, one at a time, beside the other journeys; parseArguments is checked for every value below.
      const rejected = [
        ['--minutes', '1.5', '--out', 'report-folder'], ['--out', 'report-folder', '--out', 'other-folder'], ['--minutes', '5', '--bogus', '--out', 'report-folder'],
      ]
      for (const args of rejected) {
        const result = await attempt(world, args)
        const label = result.args.join(' ')
        assert.equal(result.status, 2, label)
        assert.equal(result.stdout, '', label)
        const lines = result.stderr.trim().split(/\r?\n/)
        assert.equal(lines.length, 1, `${label}: ${result.stderr}`)
        assert.match(lines[0], /^[^\n]+\.$/, label)
        assert.doesNotMatch(result.stderr, /\n\s+at |Error|node:internal/, label)
      }
      for (const name of ['report-folder', 'other-folder', 'soak-report']) assert.equal(existsSync(join(world.root, name)), false, name)
      assert.deepEqual(readdirSync(world.root).sort(), before)
    } finally { await world.close() }
  })

  test('L6 soak arguments: a report folder that cannot be written exits 1 at once with one plain line and starts no board', async () => {
    const world = makeWorld()
    try {
      // A file where the folder's parent should be: no report can be written under it.
      writeFileSync(join(world.root, 'blocker'), 'not a folder')
      const before = readdirSync(world.root).sort()
      const result = await attempt(world, ['--minutes', '1', '--out', join(world.root, 'blocker', 'report')])
      assert.equal(result.status, 1, result.stdout + result.stderr)
      const lines = result.stdout.trim().split(/\r?\n/)
      assert.equal(lines.length, 1, result.stdout)
      assert.match(lines[0], /^soak: the report cannot be written to .+ \([A-Z]+\)\.$/)
      assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at |node:internal|warm-up/)
      assert.deepEqual(readdirSync(world.root).sort(), before)
    } finally { await world.close() }
  })

  test('L6 soak arguments: the redaction replaces the world, temp, home and working folders in both slash styles and any letter case', () => {
    const redact = makeRedact([
      ['<tmp>', 'C:\\Users\\Someone\\AppData\\Local\\Temp'], ['<world>', 'C:\\Users\\Someone\\AppData\\Local\\Temp\\agent-board-e2e-ab12'],
      ['<home>', 'C:\\Users\\Someone'], ['<repo>', 'D:\\a\\agent-board\\agent-board'],
    ])
    assert.equal(redact('C:\\Users\\Someone\\AppData\\Local\\Temp\\agent-board-e2e-ab12\\home\\x'), '<world>\\home\\x')
    assert.equal(redact('c:/users/someone/appdata/local/temp/AGENT-BOARD-E2E-AB12/home'), '<world>/home')
    assert.equal(redact('C:\\Users\\Someone\\AppData\\Local\\Temp\\other.txt'), '<tmp>\\other.txt')
    assert.equal(redact('failed at C:/Users/Someone/Desktop/notes.md.'), 'failed at <home>/Desktop/notes.md.')
    assert.equal(redact('d:\\A\\Agent-Board\\Agent-Board\\tests\\e2e\\soak.mjs and D:/a/agent-board/agent-board'), '<repo>\\tests\\e2e\\soak.mjs and <repo>')
    // A backslash written twice, as JSON writes it, is still the same path.
    assert.equal(redact('C:\\\\Users\\\\Someone\\\\x'), '<home>\\\\x')
    const posix = makeRedact([['<tmp>', '/tmp'], ['<world>', '/tmp/agent-board-e2e-ab12'], ['<home>', '/home/runner'], ['<repo>', '/home/runner/work/agent-board/agent-board']])
    assert.equal(posix('/tmp/agent-board-e2e-ab12/home/.claude'), '<world>/home/.claude')
    assert.equal(posix('/home/runner/work/agent-board/agent-board/tests'), '<repo>/tests')
    assert.equal(posix('/home/runner/.cache and /tmp/x'), '<home>/.cache and <tmp>/x')
    assert.equal(posix('/tmpfile and /tmp-two stay'), '/tmpfile and /tmp-two stay')
    assert.deepEqual(redactDeep({ 'C:/Users/Someone': ['/tmp/a', 3, { note: 'in /home/runner' }] }, posix), { 'C:/Users/Someone': ['<tmp>/a', 3, { note: 'in <home>' }] })
    assert.equal(makeRedact([], ['http://127.0.0.1:5555/?t=abcdef', 'abcdef'])('open http://127.0.0.1:5555/?t=abcdef and abcdef'), 'open <hidden> and <hidden>')
  })

  test('L6 soak arguments: whole minutes from 1 to 45 and an output folder are accepted', () => {
    assert.deepEqual(parseArguments([]), { minutes: 30, out: OUT_DEFAULT })
    assert.deepEqual(parseArguments(['--minutes', '1']), { minutes: 1, out: OUT_DEFAULT })
    assert.deepEqual(parseArguments(['--minutes', '45', '--out', 'report']), { minutes: 45, out: 'report' })
    assert.deepEqual(parseArguments(['--out', 'some folder', '--minutes', '7']), { minutes: 7, out: 'some folder' })
    for (const bad of ['0', '46', '1.5', '30m', '-1', '', ' 5', '05', '5m']) assert.match(parseArguments(['--minutes', bad]).error, /^--minutes needs a whole number from 1 to 45/, bad)
    assert.match(parseArguments(['--minutes']).error, /whole number/)
    assert.match(parseArguments(['--out', '--minutes', '5']).error, /--out needs a folder/)
    assert.match(parseArguments(['--minutes', '5', '--minutes', '6']).error, /more than once/)
    assert.match(parseArguments(['--help']).error, /Unknown argument/)
    assert.match(parseArguments(['5', '--out', 'x']).error, /Unknown argument/)
    assert.match(parseArguments(['--minutes=5']).error, /Unknown argument/)
    assert.match(parseArguments(['--out']).error, /--out needs a folder/)
    assert.match(parseArguments(['--out', 'a', '--out', 'b']).error, /more than once/)
  })

  test('L6 soak arguments: the report files are written whole, in plain words, with no path, page address or environment in them', async () => {
    const world = makeWorld()
    try {
      const address = 'http://127.0.0.1:43210/?t=Secret-Token-Value'
      const report = {
        status: 'finished', os: 'testos 1.0 x64', node: 'v24.0.0', minutes: 3, startedAt: '2026-10-21T12:00:00.000Z',
        phases: [{ name: 'warm-up', startedAt: '2026-10-21T12:00:00.000Z' }],
        polls: { count: 250, failed: 0, slow: 1, badStatus: 2, badBy: { 503: 2 }, median: 90, p95: 300, max: 1200, firstSize: 3000, lastSize: 210000, cut: { seconds: 200, isSlow: true, phase: 'tail' } },
        fileOps: [{ name: 'first 50 growth polls', perPoll: 14 }, { name: 'tail', perPoll: undefined }],
        // The first line is not the lowest: the start is the first line.
        memory: { serve: [{ seconds: 1, bytes: 90 * 1048576 }, { seconds: 10, bytes: 70 * 1048576 }, { seconds: 20, bytes: 180 * 1048576 }], watch: [] },
        data: { progressBytes: 200000, ledgerBytes: 900000, captureFiles: 1900, blocks: 300, liveSessions: 100, questionRecords: 1000 },
        archive: { path: `the page at ${address}`, tried: 290, gone: 280, refused: 2 },
        checks: [{ title: 'L6 soak: a made-up check', status: 'pass', line: `Looked under ${join(world.root, 'home')} | with a bar` }],
        notes: [`A note naming ${world.root}`],
      }
      const dir = join(world.root, 'report')
      writeReport(dir, report, makeRedact([['<world>', world.root]], [address, 'Secret-Token-Value']))
      writeReport(dir, { ...report, status: 'timed out' }, makeRedact([['<world>', world.root]], [address]))
      assert.deepEqual(readdirSync(dir).sort(), ['soak-report.json', 'soak-report.md'])
      const json = readFileSync(join(dir, 'soak-report.json'), 'utf8')
      const text = readFileSync(join(dir, 'soak-report.md'), 'utf8')
      assert.equal(JSON.parse(json).status, 'timed out')
      for (const written of [json, text]) {
        assert.ok(!written.includes(world.root.replaceAll('\\', '\\\\')) && !written.includes(world.root), 'the world folder')
        assert.ok(!written.includes('Secret-Token-Value') && !written.includes('127.0.0.1'), 'the page address')
        assert.doesNotMatch(written, /NODE_OPTIONS|E2E_CLOCK|PATH=/)
        assert.match(written, /<world>/)
      }
      assert.match(text, /^# Soak report/)
      assert.match(text, /\| Check \| Result \| What was measured \|/)
      assert.equal((text.match(/^\| L6 soak: a made-up check \| pass \|/gm) ?? []).length, 1)
      assert.match(text, /Status: timed out/)
      assert.match(text, /^Checks: 1 passed, 0 known, 0 failed, 0 skipped\.$/m)
      assert.match(text, /Polls answered with a status other than 200: 2 with 503\./)
      assert.match(text, /Page server memory: 90 MB at the start, 180 MB at the highest, 180 MB at the end\./)
      assert.match(text, /cut short after 200 s with no answer yet; it is counted as one that took longer than 15 seconds\./)
      assert.equal(tallyOf([{ status: 'pass' }, { status: 'known' }, { status: 'known' }, { status: 'fail' }, { status: 'skipped' }]), '1 passed, 2 known, 1 failed, 1 skipped')
    } finally { await world.close() }
  })

  test('L6 soak arguments: file operations per poll are the change in operations over the change in requests, per window of samples', () => {
    const samples = [{ t: 0, ops: 0, requests: 0 }, { t: 10000, ops: 100, requests: 10 }, { t: 20000, ops: 300, requests: 20 }, { t: 30000, ops: 300, requests: 20 }, { t: 40000, ops: 900, requests: 30 }]
    assert.deepEqual(fileOpsPerPoll(samples, 0, 20000), { perPoll: 15, windows: 2 })
    assert.deepEqual(fileOpsPerPoll(samples, 30000, 40000), { perPoll: 60, windows: 1 })
    // A stretch shorter than one window uses the window it touches.
    assert.deepEqual(fileOpsPerPoll(samples, 12000, 15000), { perPoll: 20, windows: 1 })
    assert.equal(fileOpsPerPoll(samples, 50000, 60000), undefined)
    assert.equal(fileOpsPerPoll([{ t: 0, ops: 0, requests: 0 }], 0, 10), undefined)
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 3, 2]), 2.5)
    assert.equal(median([]), undefined)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
    assert.equal(peakRss([{ t: 1, rss: 5 }, { t: 2, rss: 9 }, { t: 3, rss: 7 }], 2, 3), 9)
    assert.equal(peakRss([{ t: 1, rss: 5 }], 2, 3), undefined)
  })
})

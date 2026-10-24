import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'
import { knownFailure } from './lib/known.mjs'
import { OUT_DEFAULT, archiveIntegrity, archiveProblems, classifySoakChecks, fileOpsPerPoll, hookLoadMarker, leftoverPlan, leftoverProcesses, levelOutcome, makeRedact, median, parseArguments, peakRss, percentile, pruneRefusal, queuedSessions, redactDeep, tallyOf, writeReport } from './lib/soak-report.mjs'

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
  test('L6 soak results: measured successes pass while their hold identifiers remain registered', async () => {
    const titles = { ops: 'File operations', prune: 'Pruned questions', level: 'Memory level' }
    const holds = { ops: 'hold:serve-poll-file-ops', prune: 'hold:question-ledger-prune' }
    const outcomes = { ops: { ok: true, line: 'Measured 2 operations.' }, prune: { ok: true, line: 'Measured 0 leftovers.' }, level: { ok: true, hold: holds.ops, line: 'Memory settled.' } }
    const results = await classifySoakChecks({ outcomes, titles, holds, minutes: 35, knownFailure })
    assert.deepEqual(results, Object.entries(titles).map(([key, title]) => ({ title, status: 'pass', line: outcomes[key].line })))
    assert.deepEqual(holds, { ops: 'hold:serve-poll-file-ops', prune: 'hold:question-ledger-prune' })
  })
  test('L6 soak results: held failures remain known and unheld failures still fail', async () => {
    const titles = { ops: 'File operations', prune: 'Pruned questions', watch: 'Terminal board', crash: 'Crashed server' }
    const holds = { ops: 'hold:serve-poll-file-ops', prune: 'hold:question-ledger-prune', crash: 'hold:serve-poll-file-ops' }
    const outcomes = { ops: { ok: false, line: 'Too many operations.' }, prune: { ok: false, line: 'Leftovers remain.' }, watch: { ok: false, line: 'Terminal stopped.' }, crash: { ok: false, isUnheld: true, line: 'Server exited.' } }
    const results = await classifySoakChecks({ outcomes, titles, holds, minutes: 35, knownFailure })
    assert.deepEqual(results.map(one => one.status), ['known', 'known', 'fail', 'fail'])
    assert.match(results[0].line, /Known problem \(hold:serve-poll-file-ops\)/)
    assert.match(results[1].line, /Known problem \(hold:question-ledger-prune\)/)
    assert.equal(results[3].line, outcomes.crash.line)
  })
  test('L6 soak results: an unexpected known-failure error fails the check', async () => {
    const results = await classifySoakChecks({ outcomes: { ops: { ok: false, line: 'Measurement failed.' } }, titles: { ops: 'File operations' }, holds: { ops: 'invalid hold' }, minutes: 35, knownFailure })
    assert.deepEqual(results, [{ title: 'File operations', status: 'fail', line: 'Invalid known failure: invalid hold Measurement failed.' }])
  })
  test('L6 soak results: missing measurements fail full runs and may skip short runs', async () => {
    const input = { outcomes: { ops: { skipped: 'No polls completed.' } }, titles: { ops: 'File operations' }, holds: { ops: 'hold:serve-poll-file-ops' }, knownFailure }
    const full = await classifySoakChecks({ ...input, minutes: 35 })
    const short = await classifySoakChecks({ ...input, minutes: 1 })
    assert.deepEqual(full, [{ title: 'File operations', status: 'fail', line: 'Not measured in a 35-minute run: No polls completed.' }])
    assert.deepEqual(short, [{ title: 'File operations', status: 'skipped', line: 'No polls completed.' }])
  })
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
        archive: { path: `the page at ${address}`, tried: 290, gone: 280, refused: 2, resent: 1 },
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
      assert.match(text, /^- 1 archive requests were sent again after the connection closed before an answer\.$/m)
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

  // Six planned tasks: four finished (a1 to a4) and two stopped (b1, b2); c1 is a block the archive is not to touch.
  const planned = [...['a1', 'a2', 'a3', 'a4'].map(session => ({ session, title: `Task ${session}`, isStopped: false })), ...['b1', 'b2'].map(session => ({ session, title: `Task ${session}`, isStopped: true }))]
  const hold = 'hold:serve-poll-file-ops'
  const counted = '5 tasks were archived'

  test('L6 soak arguments: where each planned task ended up after the archive: archived, still there, or lost', () => {
    const titles = names => new Set(names.map(name => `Task ${name}`))
    // Everything answered and archived except b2, which the time limit left in progress.md unpressed.
    const fine = archiveIntegrity({ planned, answered: new Set(['a1', 'a2', 'a3', 'a4', 'b1']), unpressed: new Set(['b2']), present: new Set(['b2', 'c1']), archivedTitles: titles(['a1', 'a2', 'a3', 'a4', 'b1']), others: ['c1'] })
    assert.deepEqual(fine, { archived: 5, lost: 0, unarchived: 0, othersLost: 0, unpressedGone: 0, stopped: 2, stoppedLeft: 1, stoppedUnanswered: 1 })
    assert.deepEqual(archiveProblems(fine), [])
    // a4 left progress.md but is not in the archive file; b1 was answered yet is still there; c1 is
    // gone; b2 was never pressed yet left progress.md.
    const wrong = archiveIntegrity({ planned, answered: new Set(['a1', 'a2', 'a3', 'a4', 'b1']), unpressed: new Set(['b2']), present: new Set(['b1']), archivedTitles: titles(['a1', 'a2', 'a3', 'b2']), others: ['c1'] })
    assert.deepEqual(wrong, { archived: 4, lost: 1, unarchived: 1, othersLost: 1, unpressedGone: 1, stopped: 2, stoppedLeft: 1, stoppedUnanswered: 1 })
    assert.deepEqual(archiveProblems(wrong), [
      '1 tasks whose archive was answered are still in progress.md',
      '1 tasks left progress.md but are not in the archive file',
      '1 blocks the archive was not to touch left progress.md',
      '1 stopped tasks whose card was never pressed left progress.md',
    ])
    // Both stopped tasks answered, yet both still there: more left than were not answered.
    const kept = archiveIntegrity({ planned, answered: new Set(['b1', 'b2']), unpressed: new Set(), present: new Set(['b1', 'b2']), archivedTitles: titles(['a1', 'a2', 'a3', 'a4']), others: [] })
    assert.ok(archiveProblems(kept).includes('2 stopped tasks are still in progress.md, more than the 0 whose archive was not answered'))
  })

  test('L6 soak arguments: an archive with no answer in time, a 408 or one cut short is the known slowness only while file operations fail and nothing was lost', () => {
    const clean = { archived: 5, lost: 0, unarchived: 0, othersLost: 0, unpressedGone: 0, stopped: 2, stoppedLeft: 1, stoppedUnanswered: 1 }
    assert.equal(pruneRefusal({ refusals: [], integrity: clean, isOpsHeld: true, hold, counted }), undefined)
    // A wait that ran out and a 408 from the server's own wait.
    const timeout = pruneRefusal({ refusals: [{ cause: 'timeout', count: 1 }, { cause: 'timeout', count: 1 }], integrity: clean, isOpsHeld: true, hold, counted })
    assert.equal(timeout.ok, false)
    assert.equal(timeout.hold, hold)
    assert.equal(timeout.isUnheld, undefined)
    assert.match(timeout.line, /^The archive did not finish \(2 got no answer in time\), so pruning was not judged: the page server's known slowness explains it, since the file-operation check fails; nothing was lost \(5 tasks are in the archive file and 1 of the 2 stopped tasks are still in progress\.md\)\. At the end, 5 tasks were archived\.$/)
    // Stopped tasks the time limit left unreached.
    const cut = pruneRefusal({ refusals: [{ cause: 'cut', count: 1 }], integrity: clean, isOpsHeld: true, hold, counted })
    assert.equal(cut.hold, hold)
    assert.match(cut.line, /1 stopped tasks were not reached before the time limit/)
    // The same, with a task lost, an answered task still there, or another block gone: never held.
    for (const [change, words] of [[{ lost: 1 }, /1 tasks left progress\.md but are not in the archive file/], [{ unarchived: 1 }, /1 tasks whose archive was answered are still in progress\.md/], [{ othersLost: 1 }, /1 blocks the archive was not to touch left progress\.md/]]) {
      const outcome = pruneRefusal({ refusals: [{ cause: 'cut', count: 1 }], integrity: { ...clean, ...change }, isOpsHeld: true, hold, counted })
      assert.equal(outcome.isUnheld, true)
      assert.equal(outcome.hold, undefined)
      assert.match(outcome.line, words)
    }
    // With the file-operation check passing or skipped there is no known slowness to explain it.
    const unheld = pruneRefusal({ refusals: [{ cause: 'timeout', count: 1 }], integrity: clean, isOpsHeld: false, hold, counted })
    assert.equal(unheld.isUnheld, true)
    assert.match(unheld.line, /the file-operation check does not fail, so its known slowness does not explain it/)
  })

  test('L6 soak arguments: an archive refused with an error status or a failed connection fails pruning even while the slowness is held', () => {
    const clean = { archived: 5, lost: 0, unarchived: 0, othersLost: 0, unpressedGone: 0, stopped: 2, stoppedLeft: 1, stoppedUnanswered: 1 }
    for (const [refusals, words] of [[[{ cause: 'status', status: 503, count: 1 }], /1 answered 503/], [[{ cause: 'timeout', count: 1 }, { cause: 'status', status: 500, count: 1 }], /1 got no answer in time, 1 answered 500/], [[{ cause: 'refused', count: 1 }], /1 could not connect/], [[{ cause: 'closed', count: 1 }], /1 lost the connection twice before an answer/], [[{ cause: 'unreadable', count: 1 }], /1 stopped tasks could not be pressed because the board could not be read/], [[{ cause: 'button', count: 1 }], /1 stopped tasks had no Archive button/]]) {
      const outcome = pruneRefusal({ refusals, integrity: clean, isOpsHeld: true, hold, counted })
      assert.equal(outcome.ok, false)
      assert.equal(outcome.isUnheld, true)
      assert.equal(outcome.hold, undefined)
      assert.match(outcome.line, words)
      assert.match(outcome.line, /an answer other than a timeout is not the known slowness/)
    }
  })

  test('L6 soak arguments: memory after a long archive that was not measured is the known slowness only while file operations fail, and a measured rise still fails', () => {
    const megabyte = 1048576
    const unmeasured = { before: 390 * megabyte, after: undefined, settled: 1, needed: 3, settleSeconds: 20, archiveMinutes: 15.5, hold }
    const known = levelOutcome({ ...unmeasured, isOpsHeld: true })
    assert.equal(known.ok, false)
    assert.equal(known.hold, hold)
    assert.match(known.line, /^Not measured: the archive ran 15\.5 min, so 1 memory lines came after it and 3 are needed; the page server's known slowness explains it, since the file-operation check fails\.$/)
    assert.deepEqual(levelOutcome({ ...unmeasured, isOpsHeld: false }), { skipped: 'Only 1 memory lines came from 20 s after the archive on, 3 are needed.' })
    // Measured: a rise past the limit fails whatever the file-operation check says, and a level line passes.
    const rise = levelOutcome({ ...unmeasured, after: 500 * megabyte, settled: 3, isOpsHeld: true })
    assert.equal(rise.ok, false)
    assert.equal(rise.hold, undefined)
    assert.match(rise.line, /^The page server's highest memory was 390 MB up to the end of the archive and 500 MB after it \(limit 439 MB\)\.$/)
    assert.equal(levelOutcome({ ...unmeasured, after: 379 * megabyte, settled: 3, isOpsHeld: true }).ok, true)
  })
  test('L6 soak arguments: a leftover process of the hook load is one the run started, found by its parent chain or by the world folder in its command line, never the run, its lister or another world', () => {
    const world = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\agent-board-e2e-AbC123`
    const list = [
      { pid: 100, ppid: 1, started: 1000, name: 'node.exe', command: 'node tests/e2e/hook-load.mjs' },
      { pid: 101, ppid: 100, started: 1001, name: 'cmd.exe', command: 'cmd.exe /d /s /c "node hook"' },
      { pid: 102, ppid: 101, started: 1002, name: 'node.exe', command: 'node -e worker' },
      // A stale parent id names this run, but the process was already there before the run started.
      { pid: 103, ppid: 100, started: 999, name: 'node.exe', command: 'node -e unrelated' },
      { pid: 104, ppid: 103, started: 1003, name: 'node.exe', command: 'node -e unrelated-child' },
      // A worker whose parent is gone, found by the world folder in either slash style and any letter case.
      { pid: 200, ppid: 4, name: 'node.exe', command: `node ${world.toLowerCase().replaceAll('\\', '/')}/home/.claude/agent-board.mjs --serve` },
      // Another world whose name only starts with this one's, and a process of nobody's.
      { pid: 300, ppid: 4, name: 'node.exe', command: String.raw`node ${world}4\home\.claude\agent-board.mjs` },
      { pid: 500, ppid: 1, name: 'explorer.exe', command: 'explorer.exe' },
      // The lister and its console.
      { pid: 400, ppid: 100, name: 'powershell.exe', command: 'powershell.exe -Command Get-CimInstance' },
      { pid: 401, ppid: 400, name: 'conhost.exe', command: 'conhost.exe 0xffffffff' },
      // Windows may also attach a console directly to this run.
      { pid: 402, ppid: 100, name: 'ConHost.EXE', command: 'conhost.exe 0xffffffff' },
    ]
    assert.deepEqual(leftoverProcesses({ list, self: 100, roots: [world, undefined], exclude: [400] }).map(one => one.pid), [101, 102, 200])
    assert.deepEqual(leftoverProcesses({ list: list.filter(one => ![101, 102, 200].includes(one.pid)), self: 100, roots: [world], exclude: [400] }), [])
    // Missing creation times keep the parent-chain fallback used on macOS.
    assert.deepEqual(leftoverProcesses({ list: list.filter(one => one.pid !== 104).map(({ started, ...one }) => one), self: 100, roots: [world], exclude: [400] }).map(one => one.pid), [101, 102, 103, 200])
    // A parent chain that loops ends without hanging.
    assert.deepEqual(leftoverProcesses({ list: [{ pid: 7, ppid: 8, name: 'a', command: '' }, { pid: 8, ppid: 7, name: 'b', command: '' }], self: 100, roots: [] }), [])
  })
  test("L6 soak arguments: the leftover plan kills this run's descendants and its later path matches, and only reports a path match that started before the run", () => {
    const world = '/tmp/agent-board-e2e-this-run'
    const list = [
      { pid: 100, ppid: 1, started: 1000, name: 'node', command: 'node hook-load.mjs' },
      { pid: 101, ppid: 100, name: 'node', command: 'node child' },
      { pid: 102, ppid: 101, started: 1002, name: 'node', command: 'node grandchild' },
      { pid: 200, ppid: 4, started: 2000, name: 'node', command: `node ${world}/worker` },
      { pid: 201, ppid: 4, started: 500, name: 'node', command: `node ${world}/worker` },
      { pid: 202, ppid: 4, name: 'node', command: `node ${world}/worker` },
      { pid: 300, ppid: 4, started: 2000, name: 'node', command: 'node /tmp/agent-board-e2e-another-run/worker' },
    ]
    const plan = leftoverPlan({ list, self: 100, roots: [world] })
    assert.deepEqual(plan.kill, [list[1], list[2], list[3]])
    assert.deepEqual(plan.keep, [list[4], list[5]])
    const orphaned = leftoverPlan({ list, self: undefined, since: 100, roots: [world] })
    assert.deepEqual(orphaned.kill, [list[3]])
    assert.deepEqual(orphaned.keep, [list[4], list[5]])
    const noStart = list.map(one => one.pid === 100 ? { ...one, started: undefined } : one)
    assert.deepEqual(leftoverPlan({ list: noStart, self: 100, roots: [world] }), { kill: [noStart[1], noStart[2]], keep: [noStart[3], noStart[4], noStart[5]] })
    assert.deepEqual(leftoverPlan({ list: [{ ...list[0], pid: 99 }, ...noStart], self: 100, since: 99, roots: [world] }), plan)
    assert.deepEqual(leftoverPlan({ list: [{ ...list[0], pid: 99, started: 500 }, ...list], self: 100, since: 99, roots: [world] }), plan)
    assert.deepEqual(leftoverPlan({ list, self: 999, since: 100, roots: [world] }), orphaned)
    assert.deepEqual(leftoverPlan({ list, self: 100, roots: [world], exclude: [101, 200] }), { kill: [], keep: [list[4], list[5]] })
    const sameStart = { ...list[3], started: 1000 }
    assert.deepEqual(leftoverPlan({ list: [list[0], sameStart], self: 100, roots: [world] }), { kill: [sameStart], keep: [] })
  })
  test('L6 soak arguments: an orphaned PowerShell hook counts only when its encoded command names this world', () => {
    const world = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\agent-board-e2e-AbC123`
    const encoded = script => Buffer.from(script, 'utf16le').toString('base64')
    const list = ['-EncodedCommand', '-ENC', '-eC', '-E'].flatMap((flag, index) => [
      { pid: 200 + index, ppid: 4, name: 'powershell.exe', command: `powershell.exe -NoProfile ${flag} ${encoded(`& '${world}/home/.claude/agent-board.mjs'`)}` },
      { pid: 300 + index, ppid: 4, name: 'powershell.exe', command: `powershell.exe -NoProfile ${flag} ${encoded(`& '${world}4/home/.claude/agent-board.mjs'`)}` },
    ])
    list.push(
      { pid: 400, ppid: 4, name: 'powershell.exe', command: 'powershell.exe -enc not-base64!' },
      { pid: 401, ppid: 4, name: 'powershell.exe', command: 'powershell.exe -enc YQ==' },
      { pid: 402, ppid: 4, name: 'powershell.exe', command: 'powershell.exe -enc ANg=' },
      { pid: 204, ppid: 4, name: 'cmd.exe', command: `cmd /d /s /c "powershell.exe -NoProfile -EncodedCommand ${encoded(`& '${world}/home/.claude/agent-board.mjs'`)}"` },
    )
    assert.deepEqual(leftoverProcesses({ list, self: 100, roots: [world] }).map(one => one.pid), [200, 201, 202, 203, 204])
    assert.deepEqual(leftoverProcesses({ list, self: 100, roots: [world], exclude: [201] }).map(one => one.pid), [200, 202, 203, 204])
  })
  test('L6 soak arguments: queued sessions come from raw hook payloads and board entries, skipping malformed, unreadable and temporary files', () => {
    const raw = payload => JSON.stringify({ version: 1, kind: 'raw', at: 1000, argv: [], env: {}, payload })
    const sessions = queuedSessions([
      { name: '1000-a.raw.json', text: raw({ session_id: 'load-codex-0' }) },
      { name: '1001-b.raw.json', text: raw({ sessionId: 'load-grok-1' }) },
      { name: '1002-c.raw.json', text: raw({ conversationId: 'load-antigravity-2' }) },
      { name: '1003-d.json', text: JSON.stringify({ version: 1, session: 'load-codex-3', payload: {} }) },
      { name: '1004-e.json', text: '{broken' },
      { name: '1005-f.json' },
      { name: '1006-g.raw.json.tmp', text: raw({ session_id: 'load-codex-4' }) },
      { name: '1007-h.json', text: 'null' },
      { name: '1008-i.raw.json', text: raw({ session_id: 42 }) },
    ])
    assert.deepEqual([...sessions], ['load-codex-0', 'load-grok-1', 'load-antigravity-2', 'load-codex-3'])
    assert.equal(sessions.has('load-codex-4'), false)
    assert.equal(sessions.has('load-codex-5'), false)
  })
  test('L6 soak arguments: a failed hook load check is known for #241 only on Windows, when no hook exited non-zero or ran past twice the 3 s budget, the poll interval fits its budget, every poll was answered, some report was shown and every late or missed report came back while that session\'s own event was queued', () => {
    const marker = (key, outcome, platform = 'win32') => hookLoadMarker({ key, outcome, platform, budgetMs: 3000 })
    const slowHooks = { ok: false, over: 1, failedRuns: 0, maxMs: 3126 }
    const latePage = { ok: false, shown: 2182, slow: 30, slowNotQueued: 0, failedAnswers: 0, pollWithinBudget: true }
    assert.deepEqual(marker('hooks', slowHooks), { issue: 241, explains: true })
    assert.deepEqual(marker('page', latePage), { issue: 241, explains: true })
    // A lucky pass on Windows still carries the marker; other systems and other checks carry none.
    assert.deepEqual(marker('hooks', { ok: true }), { issue: 241, explains: true })
    assert.deepEqual(marker('page', { ok: true, pollWithinBudget: true }), { issue: 241, explains: true })
    assert.equal(marker('hooks', slowHooks, 'linux'), undefined)
    assert.equal(marker('page', latePage, 'darwin'), undefined)
    assert.equal(marker('caps', { ok: false }), undefined)
    // Outside the pattern: a hook that exited non-zero, one that ran past 6 s, a failure with no slow
    // run, a late report without its own queued event, a bad poll interval, an unanswered poll, no report shown, or nothing slow.
    assert.equal(marker('hooks', { ...slowHooks, failedRuns: 1 }).explains, false)
    assert.equal(marker('hooks', { ...slowHooks, maxMs: 6001 }).explains, false)
    assert.equal(marker('hooks', { ok: false, over: 0, failedRuns: 0, maxMs: 0 }).explains, false)
    assert.equal(marker('page', { ...latePage, slowNotQueued: 1 }).explains, false)
    assert.equal(marker('page', { ...latePage, pollWithinBudget: false }).explains, false)
    assert.equal(marker('page', { ...latePage, pollWithinBudget: undefined }).explains, false)
    assert.equal(marker('page', { ok: true, pollWithinBudget: false }).explains, false)
    assert.equal(marker('page', { ...latePage, failedAnswers: 1 }).explains, false)
    assert.equal(marker('page', { ...latePage, shown: 0 }).explains, false)
    assert.equal(marker('page', { ...latePage, slow: 0 }).explains, false)
    assert.equal(marker('page', {}).explains, false)
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The sampler is a PowerShell script for the Windows CI jobs (#1249), so its tests run there only.
// CI has pwsh; a Windows computer without it falls back to the built-in powershell.exe, which the
// script also supports. The workflow test runs everywhere.
const script = fileURLToPath(new URL('../scripts/ci-sampler.ps1', import.meta.url))
const workflow = fileURLToPath(new URL('../.github/workflows/test.yml', import.meta.url))
const shell = process.platform === 'win32' ? ['pwsh', 'powershell'].find(name => spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0) : undefined
const skip = process.platform !== 'win32' ? 'Windows sampler' : !shell && 'no PowerShell found'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const scratch = () => mkdtempSync(join(tmpdir(), 'ci-sampler-'))
const waitFor = async (check, ms) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (check()) return true
    await sleep(100)
  }
  return check()
}
const pidAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const aliveOf = dir => readJson(join(dir, 'alive.json'))
const gapLines = dir => { try { return readFileSync(join(dir, 'gaps.jsonl'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const stop = dir => spawnSync(shell, ['-NoProfile', '-File', script, 'stop', dir], { encoding: 'utf8', timeout: 20000 })
// The loop, run as this test's own child. Its stop file ends it once the test has what it waits
// for, and `finally` ends it if it is still running.
const runLoop = async (dir, args, ready) => {
  const child = spawn(shell, ['-NoProfile', '-File', script, 'run', dir, ...args], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise(done => child.on('exit', done))
  try {
    // A slow shell start must not let the stop file come before the first tick.
    assert.ok(await waitFor(ready, 30000), 'the sampler ticked')
    writeFileSync(join(dir, 'stop'), 'stop')
    return await Promise.race([exited, sleep(10000).then(() => 'timeout')])
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await Promise.race([exited, sleep(5000)])
    }
  }
}
const record = (gapMs, at, extra = {}) => ({ at, gapMs, wallMs: gapMs, systemBusyMs: 100, systemIdleMs: 100, cores: 2, readMs: 5, sinceSnapshotMs: gapMs, top: [], totalCpuMs: 0, freeMemoryMB: 4000, diskQueue: 0, ...extra })
const ended = { ticks: 40, gaps: 0, saved: 0, gapMs: 1000, maxGapMs: 0, ended: true }

test('a gap writes one line with every field, and stop prints it with the share the system counted', { skip }, async () => {
  const dir = scratch()
  try {
    const code = await runLoop(dir, ['-GapMs', '0'], () => gapLines(dir).length >= 1)
    assert.equal(code, 0)
    const lines = gapLines(dir)
    for (const line of lines) {
      const gap = JSON.parse(line)
      assert.ok(!Number.isNaN(Date.parse(gap.at)), 'at is a date')
      for (const field of ['gapMs', 'wallMs', 'systemBusyMs', 'systemIdleMs', 'readMs', 'sinceSnapshotMs', 'totalCpuMs']) assert.equal(typeof gap[field], 'number', field)
      assert.ok(gap.readMs >= 0)
      assert.ok(Number.isInteger(gap.cores) && gap.cores >= 1)
      assert.ok(Array.isArray(gap.top) && gap.top.length <= 10)
      for (const row of gap.top) assert.deepEqual([typeof row.name, typeof row.id, typeof row.cpuMs], ['string', 'number', 'number'])
      assert.ok('freeMemoryMB' in gap && 'diskQueue' in gap)
    }
    const alive = aliveOf(dir)
    assert.equal(alive.ended, true)
    assert.equal(alive.saved, alive.gaps)
    const stopped = stop(dir)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, new RegExp(`^windows sampler: ${alive.ticks} ticks, ${alive.gaps} gaps over 0 ms\\r?$`, 'm'))
    assert.match(stopped.stdout, /^gap \d+ ms, accounted \d+(\.\d+)?: \{/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a quiet run records no gap and stop says 0 gaps', { skip }, async () => {
  const dir = scratch()
  try {
    const code = await runLoop(dir, ['-GapMs', '60000'], () => aliveOf(dir)?.ticks >= 1)
    assert.equal(code, 0)
    assert.equal(existsSync(join(dir, 'gaps.jsonl')), false)
    const stopped = stop(dir)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /^windows sampler: \d+ ticks, 0 gaps over 60000 ms\r?$/m)
    assert.doesNotMatch(stopped.stdout, /^gap /m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pause inside a periodic snapshot is recorded as a gap', { skip }, async () => {
  const dir = scratch()
  try {
    // A snapshot every tick, each held 1.5 s: the wait stands in for a VM pause during the snapshot.
    const code = await runLoop(dir, ['-GapMs', '1000', '-SnapshotMs', '0', '-SnapshotDelayMs', '1500'], () => gapLines(dir).length >= 1)
    assert.equal(code, 0)
    const gaps = gapLines(dir).map(line => JSON.parse(line))
    assert.ok(gaps.some(gap => gap.gapMs >= 1500 && gap.wallMs >= 1400), `a gap of at least the held time on both clocks: ${JSON.stringify(gaps)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a gap that could not be saved shows the record as incomplete', { skip }, async () => {
  const dir = scratch()
  try {
    // A folder where the record file should be, so every write of a gap fails.
    mkdirSync(join(dir, 'gaps.jsonl'))
    const code = await runLoop(dir, ['-GapMs', '0'], () => aliveOf(dir)?.gaps >= 1)
    assert.equal(code, 0)
    const alive = aliveOf(dir)
    assert.equal(alive.saved, 0)
    const stopped = stop(dir)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, new RegExp(`, ${alive.gaps} not saved \\(the record is incomplete\\)`))
    // A loop that has not ended still shows its unsaved gaps.
    writeFileSync(join(dir, 'alive.json'), JSON.stringify({ ...ended, ended: false, gaps: 3, saved: 1 }))
    const late = stop(dir)
    assert.equal(late.status, 0, late.stderr)
    assert.match(late.stdout, /^windows sampler: 40 ticks, 3 gaps over 1000 ms, the loop had not ended after 3 s, 2 not saved \(the record is incomplete\)\r?$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop exits 0 with a summary for a missing folder, a corrupt line and unreadable counters', { skip }, () => {
  const dir = scratch()
  try {
    const missing = stop(join(dir, 'missing'))
    assert.equal(missing.status, 0, missing.stderr)
    assert.match(missing.stdout, /^windows sampler: no record \(the sampler did not start\)/)
    assert.equal(existsSync(join(dir, 'missing')), false)

    writeFileSync(join(dir, 'alive.json'), JSON.stringify({ ...ended, gaps: 2, saved: 2 }))
    writeFileSync(join(dir, 'gaps.jsonl'), `{"at":\n${JSON.stringify(record(9000, '2026-01-31T09:30:00.0000000Z', { systemBusyMs: null, systemIdleMs: null }))}\n`)
    const corrupt = stop(dir)
    assert.equal(corrupt.status, 0, corrupt.stderr)
    assert.match(corrupt.stdout, /^windows sampler: 40 ticks, 2 gaps over 1000 ms, 1 unreadable lines in gaps\.jsonl\r?$/m)
    assert.match(corrupt.stdout, /^gap 9000 ms, accounted unknown: \{/m)

    writeFileSync(join(dir, 'alive.json'), 'not json')
    const noAlive = stop(dir)
    assert.equal(noAlive.status, 0, noAlive.stderr)
    assert.match(noAlive.stdout, /^windows sampler: \? ticks, 2 gaps over 1000 ms, no readable alive\.json/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop prints accounted = (busy + idle) / (gap x cores) for the 20 largest gaps, in the order they were written', { skip }, () => {
  const dir = scratch()
  try {
    // 25 gaps; the five smallest are the first five.
    const gaps = Array.from({ length: 25 }, (_, i) => record(1001 + i, `2026-01-31T09:30:${String(10 + i).padStart(2, '0')}.0000000Z`))
    gaps[24] = record(4000, gaps[24].at, { systemBusyMs: 1000, systemIdleMs: 5000 })
    writeFileSync(join(dir, 'alive.json'), JSON.stringify({ ...ended, gaps: 25, saved: 25 }))
    writeFileSync(join(dir, 'gaps.jsonl'), gaps.map(gap => JSON.stringify(gap)).join('\n') + '\n')
    const stopped = stop(dir)
    assert.equal(stopped.status, 0, stopped.stderr)
    const printed = stopped.stdout.split(/\r?\n/).filter(line => line.startsWith('gap '))
    assert.equal(printed.length, 20)
    assert.deepEqual(printed.map(line => Number(line.split(' ')[1])), [...gaps.slice(5, 24).map(gap => gap.gapMs), 4000])
    // (1000 + 5000) / (4000 x 2) and (100 + 100) / (1006 x 2).
    assert.match(printed[19], /^gap 4000 ms, accounted 0\.75: \{/)
    assert.match(printed[0], /^gap 1006 ms, accounted 0\.1: \{/)
    assert.match(stopped.stdout, /^5 smaller gaps not shown\r?$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a memory read that fails without stopping is recorded as unknown, not as no free memory', { skip }, async () => {
  const dir = scratch()
  // A function of the same name runs instead of the cmdlet: it reports an error and returns nothing, as a failed CIM query can.
  const child = spawn(shell, ['-NoProfile', '-Command', `function Get-CimInstance { Write-Error 'synthetic CIM failure' }; & '${script.replaceAll("'", "''")}' run '${dir.replaceAll("'", "''")}' -GapMs 0`], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise(done => child.on('exit', done))
  try {
    assert.ok(await waitFor(() => gapLines(dir).length >= 1, 30000), 'a gap was written')
    writeFileSync(join(dir, 'stop'), 'stop')
    await Promise.race([exited, sleep(10000)])
    const gaps = gapLines(dir).map(line => JSON.parse(line))
    assert.ok(gaps.length >= 1)
    for (const gap of gaps) assert.equal(gap.freeMemoryMB, null)
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await Promise.race([exited, sleep(5000)])
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start returns at once, and stop ends the loop it started without ending it by force', { skip }, async () => {
  const dir = scratch()
  let pid = 0
  try {
    const began = Date.now()
    const started = spawnSync(shell, ['-NoProfile', '-File', script, 'start', dir], { encoding: 'utf8' })
    // The pid is read first, so `finally` can end the sampler even when an assertion below fails.
    pid = Number(started.stdout.match(/sampler started \(pid (\d+)\)/)?.[1])
    assert.equal(started.status, 0, started.stderr)
    assert.ok(Date.now() - began < 15000, 'start does not wait for the sampler')
    assert.ok(pid > 0, started.stdout)
    assert.ok(await waitFor(() => aliveOf(dir)?.ticks >= 1, 30000), 'the loop ticked')
    const stopped = stop(dir)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /^windows sampler: \d+ ticks, \d+ gaps over 1000 ms\r?$/m)
    assert.equal(aliveOf(dir).ended, true)
    assert.ok(await waitFor(() => !pidAlive(pid), 5000), 'the loop has ended')
  } finally {
    if (pid && pidAlive(pid)) try { process.kill(pid) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the board job starts and stops the sampler on Windows only, each step can neither fail nor hold the job, and nothing is uploaded', () => {
  const text = readFileSync(workflow, 'utf8')
  const jobs = Object.fromEntries(text.split(/^ {2}(?=[a-z-]+:\r?$)/m).slice(1).map(block => [block.slice(0, block.indexOf(':')), block]))
  const withSampler = Object.keys(jobs).filter(name => jobs[name].includes('ci-sampler.ps1'))
  assert.ok(withSampler.includes('board'), 'the board job runs the sampler')
  for (const name of withSampler) {
    const steps = jobs[name].split(/^ {6}- /m)
    const start = steps.findIndex(step => step.includes('scripts/ci-sampler.ps1 start "$env:RUNNER_TEMP/windows-sampler"'))
    const end = steps.findIndex(step => step.includes('scripts/ci-sampler.ps1 stop "$env:RUNNER_TEMP/windows-sampler"'))
    assert.ok(start > 0 && end > start, `${name}: start, then stop`)
    assert.match(steps[start], /^ +if: runner\.os == 'Windows'\r?$/m, `${name}: start on Windows only`)
    assert.match(steps[end], /^ +if: always\(\) && runner\.os == 'Windows'\r?$/m, `${name}: stop after a failure too`)
    for (const step of [steps[start], steps[end]]) {
      assert.match(step, /^ +continue-on-error: true\r?$/m, `${name}: cannot fail the job`)
      assert.match(step, /^ +timeout-minutes: 1\r?$/m, `${name}: cannot hold the job`)
    }
    assert.equal(steps.filter(step => step.includes('ci-sampler.ps1')).length, 2, `${name}: two sampler steps`)
    // Each sampler step gets a minute of its own on Windows, so the two never take time the job's tests had (#1249).
    const limit = jobs[name].match(/^ {4}timeout-minutes: \$\{\{ matrix\.os == 'windows-latest' && (\d+) \|\| (\d+) \}\}\r?$/m)
    assert.ok(limit, `${name}: a Windows limit of its own`)
    assert.equal(Number(limit[1]), Number(limit[2]) + 2, `${name}: one more minute for each sampler step`)
  }
  assert.equal(text.match(/windows-sampler/g).length, 2 * withSampler.length, 'the record is not uploaded or used elsewhere')
})

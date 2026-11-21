import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The sampler is a PowerShell script for the Windows CI jobs (#1249), so these tests run there only.
// CI has pwsh; a Windows computer without it falls back to the built-in powershell.exe, which the
// script also supports.
const script = fileURLToPath(new URL('../scripts/ci-sampler.ps1', import.meta.url))
const shell = ['pwsh', 'powershell'].find(name => spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0)
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
const gapLines = dir => existsSync(join(dir, 'gaps.jsonl')) ? readFileSync(join(dir, 'gaps.jsonl'), 'utf8').split('\n').filter(Boolean) : []
const stopIn = dir => spawnSync(shell, ['-NoProfile', '-Command', `Set-Content -LiteralPath '${join(dir, 'stop')}' -Value stop`])
const summaryOf = (dir, ...args) => spawnSync(shell, ['-NoProfile', '-File', script, 'stop', dir, ...args], { encoding: 'utf8', timeout: 20000 })
// The loop run in the foreground, as start runs it in the background. It is stopped by its stop file
// once the test has what it waits for, and ended in `finally` if it is still running.
const runLoop = async (dir, args, ready) => {
  const child = spawn(shell, ['-NoProfile', '-File', script, 'run', dir, ...args], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise(done => child.on('exit', done))
  try {
    // A slow shell start must not let the stop file come before the first tick.
    assert.ok(await waitFor(ready, 30000), 'the sampler ticked')
    stopIn(dir)
    return await Promise.race([exited, sleep(10000).then(() => 'timeout')])
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await Promise.race([exited, sleep(5000)])
    }
  }
}

test('run mode with every tick counted as a gap writes complete records', { skip }, async () => {
  const dir = scratch()
  try {
    const code = await runLoop(dir, ['-GapMs', '0'], () => gapLines(dir).length >= 1 && existsSync(join(dir, 'alive.json')))
    assert.equal(code, 0)
    const lines = gapLines(dir)
    assert.ok(lines.length >= 1, 'at least one gap was recorded')
    for (const line of lines) {
      const record = JSON.parse(line)
      assert.ok(!Number.isNaN(Date.parse(record.at)), 'at is a date')
      assert.equal(typeof record.gapMs, 'number')
      assert.equal(typeof record.sinceSnapshotMs, 'number')
      assert.equal(typeof record.totalCpuMs, 'number')
      assert.equal(typeof record.systemBusyMs, 'number')
      assert.equal(typeof record.systemIdleMs, 'number')
      assert.ok(Number.isInteger(record.cores) && record.cores >= 1)
      assert.ok(Array.isArray(record.top) && record.top.length <= 10)
      for (const row of record.top) {
        assert.equal(typeof row.name, 'string')
        assert.equal(typeof row.id, 'number')
        assert.equal(typeof row.cpuMs, 'number')
      }
      assert.ok(record.freeMemoryMB === null || typeof record.freeMemoryMB === 'number')
      assert.ok(record.diskQueue === null || typeof record.diskQueue === 'number')
      assert.ok('freeMemoryMB' in record && 'diskQueue' in record)
    }
    assert.ok(existsSync(join(dir, 'alive.json')), 'alive.json is written on the way out')
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
    const gaps = gapLines(dir).map(line => JSON.parse(line).gapMs)
    assert.ok(gaps.some(gap => gap >= 1500), `a gap of at least the held time: ${gaps}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start returns at once with a pid file, and stop ends the process and prints a summary', { skip }, async () => {
  const dir = scratch()
  let pid = 0
  try {
    const began = Date.now()
    const started = spawnSync(shell, ['-NoProfile', '-File', script, 'start', dir, '-GapMs', '0'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    assert.ok(Date.now() - began < 15000, 'start does not wait for the sampler')
    assert.match(started.stdout, /sampler started/)
    const [id, startTicks] = readFileSync(join(dir, 'sampler.pid'), 'utf8').trim().split(/\s+/)
    pid = Number(id)
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.match(startTicks, /^[1-9]\d*$/, 'the pid file holds the start time')
    assert.ok(pidAlive(pid), 'the sampler is running')
    await waitFor(() => existsSync(join(dir, 'gaps.jsonl')), 30000)
    const stopped = summaryOf(dir, '-GapMs', '0')
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /windows sampler: .* ticks, \d+ gaps over 0 ms/)
    assert.ok(await waitFor(() => !pidAlive(pid), 5000), 'the sampler has ended')
  } finally {
    if (pid && pidAlive(pid)) try { process.kill(pid) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop leaves alone a process that has the sampler\'s id but not its start time', { skip }, async () => {
  const dir = scratch()
  // An unrelated process that got the id of a sampler that had already ended.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise(done => other.on('exit', done))
  try {
    for (const text of [`${other.pid}`, `${other.pid} 1`]) {
      writeFileSync(join(dir, 'sampler.pid'), `${text}\n`)
      const stopped = summaryOf(dir)
      assert.equal(stopped.status, 0, stopped.stderr)
      assert.match(stopped.stdout, /windows sampler: /)
      assert.ok(pidAlive(other.pid), `the process named by '${text}' still runs`)
    }
  } finally {
    other.kill()
    await Promise.race([exited, sleep(5000)])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the summary reads a pause from the system\'s busy time, which also counts processes that exited during the gap', { skip }, () => {
  const record = { at: '2026-01-31T09:30:00.000Z', gapMs: 9000, systemIdleMs: 300, cores: 4, sinceSnapshotMs: 9100, freeMemoryMB: 4000, diskQueue: 0 }
  const cases = [
    // Nothing ran: under a quarter of one core over the gap.
    [{ ...record, systemBusyMs: 120, top: [], totalCpuMs: 0 }, /busy CPU over it 120 ms on 4 cores, under a quarter of one core: nothing ran, so the VM was likely paused/],
    // The processes still running gained little, but the system was busy: one that exited took it.
    [{ ...record, systemBusyMs: 30000, top: [{ name: 'synthetic-survivor', id: 1234, cpuMs: 40 }], totalCpuMs: 40 }, /busy CPU over it 30000 ms on 4 cores\r?$/m],
  ]
  for (const [gap, expected] of cases) {
    const dir = scratch()
    try {
      writeFileSync(join(dir, 'gaps.jsonl'), `${JSON.stringify(gap)}\n`)
      const stopped = summaryOf(dir)
      assert.equal(stopped.status, 0, stopped.stderr)
      assert.match(stopped.stdout, expected)
      if (gap.systemBusyMs > gap.gapMs / 4) assert.doesNotMatch(stopped.stdout, /paused/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

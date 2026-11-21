import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

test('run mode with every tick counted as a gap writes complete records', { skip }, async () => {
  const dir = scratch()
  try {
    const child = spawn(shell, ['-NoProfile', '-File', script, 'run', dir, '-GapMs', '0'], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise(done => child.on('exit', done))
    await sleep(2000)
    spawnSync(shell, ['-NoProfile', '-Command', `Set-Content -LiteralPath '${join(dir, 'stop')}' -Value stop`])
    const code = await Promise.race([exited, sleep(10000).then(() => 'timeout')])
    assert.equal(code, 0)
    const lines = readFileSync(join(dir, 'gaps.jsonl'), 'utf8').split('\n').filter(Boolean)
    assert.ok(lines.length >= 1, 'at least one gap was recorded')
    for (const line of lines) {
      const record = JSON.parse(line)
      assert.ok(!Number.isNaN(Date.parse(record.at)), 'at is a date')
      assert.equal(typeof record.gapMs, 'number')
      assert.equal(typeof record.sinceSnapshotMs, 'number')
      assert.equal(typeof record.totalCpuMs, 'number')
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

test('start returns at once with a pid file, and stop ends the process and prints a summary', { skip }, async () => {
  const dir = scratch()
  let pid = 0
  try {
    const began = Date.now()
    const started = spawnSync(shell, ['-NoProfile', '-File', script, 'start', dir, '-GapMs', '0'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    assert.ok(Date.now() - began < 15000, 'start does not wait for the sampler')
    assert.match(started.stdout, /sampler started/)
    pid = Number(readFileSync(join(dir, 'sampler.pid'), 'utf8').trim())
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.ok(pidAlive(pid), 'the sampler is running')
    await waitFor(() => existsSync(join(dir, 'gaps.jsonl')), 8000)
    const stopped = spawnSync(shell, ['-NoProfile', '-File', script, 'stop', dir, '-GapMs', '0'], { encoding: 'utf8', timeout: 20000 })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.match(stopped.stdout, /windows sampler: .* ticks, \d+ gaps over 0 ms/)
    assert.ok(await waitFor(() => !pidAlive(pid), 5000), 'the sampler has ended')
  } finally {
    if (pid && pidAlive(pid)) try { process.kill(pid) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

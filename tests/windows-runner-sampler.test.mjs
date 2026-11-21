import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  classifyGap,
  classifyRecord,
  computeCpuDeltas,
  formatSummary,
  readSamplerRecord,
  sanitizeArtifactName,
} from '../scripts/windows-runner-sampler.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const samplerMjs = fileURLToPath(new URL('../scripts/windows-runner-sampler.mjs', import.meta.url))
const samplerPs1 = fileURLToPath(new URL('../scripts/windows-runner-sampler.ps1', import.meta.url))

test('sanitizeArtifactName turns job and matrix names into unique upload-artifact safe names', () => {
  assert.equal(sanitizeArtifactName('board-node24-part-1/7'), 'windows-sampler-board-node24-part-1-of-7')
  assert.equal(sanitizeArtifactName('Messaging: Node 22 (1/3)?'), 'windows-sampler-messaging-node-22-1-of-3')
  assert.equal(sanitizeArtifactName('  /  '), 'windows-sampler-of')
  assert.equal(sanitizeArtifactName('  ///  '), 'windows-sampler-of-of-of')
  assert.equal(sanitizeArtifactName(''), 'windows-sampler-job')
  assert.equal(sanitizeArtifactName('x'.repeat(150)).length <= 100, true)

  const matrixJobs = [
    'board-node22-part-1/7',
    'board-node24-part-1/7',
    'board-node24-part-2/7',
    'messaging-node24-part-1/3',
    'messaging-node24-part-2/3',
    'tooling-node24',
    'npm-node24',
    'plugin',
    'installers',
    'remote',
    'journeys-node24-part-1/3',
    'journeys-node24-part-3/3',
    'browser',
  ]
  const names = matrixJobs.map(sanitizeArtifactName)
  assert.equal(new Set(names).size, matrixJobs.length)
  for (const name of names) {
    assert.match(name, /^windows-sampler-[a-z0-9._-]+$/)
    assert.ok(name.length <= 100, name)
  }
})

test('computeCpuDeltas attributes per-process CPU deltas across instance renames, PID reuse, and Idle', () => {
  const before = [
    { pid: 0, name: 'Idle', cpuMs: 1_000_000, createdRaw: 0 },
    { pid: 0, name: '_Total', cpuMs: 1_500_000, createdRaw: 0 },
    { pid: 4, name: 'System', cpuMs: 10_000, createdRaw: 100 },
    { pid: 101, name: 'node#1', cpuMs: 2_000, createdRaw: 200 },
    { pid: 202, name: 'oldproc', cpuMs: 50_000, createdRaw: 300 },
    { pid: 303, name: 'unchanged', cpuMs: 400, createdRaw: 400 },
    { pid: 404, name: 'clockdrift', cpuMs: 900, createdRaw: 500 },
  ]
  const after = [
    { pid: 0, name: 'idle', cpuMs: 1_005_500, createdRaw: 0 },
    { pid: 0, name: '_Total', cpuMs: 1_540_000, createdRaw: 0 },
    { pid: 4, name: 'System', cpuMs: 10_300, createdRaw: 100 },
    { pid: 101, name: 'node', cpuMs: 2_900, createdRaw: 200 },
    // PID 202 reused by a different process (different createdRaw): count its full CPU time.
    { pid: 202, name: 'MsMpEng', cpuMs: 28_000, createdRaw: 999 },
    // Brand new process not seen before.
    { pid: 505, name: 'TiWorker#2', cpuMs: 4_000, createdRaw: 1000 },
    { pid: 303, name: 'unchanged', cpuMs: 400, createdRaw: 400 },
    { pid: 404, name: 'clockdrift', cpuMs: 850, createdRaw: 500 },
  ]

  const result = computeCpuDeltas(before, after)
  assert.equal(result.idleCpuGainedMs, 5_500)
  assert.equal(result.totalCpuGainedMs, 28_000 + 4_000 + 900 + 300)
  assert.deepEqual(
    result.processes.map(item => [item.pid, item.name, item.cpuGainedMs]),
    [
      [202, 'msmpeng', 28_000],
      [505, 'tiworker', 4_000],
      [101, 'node', 900],
      [4, 'system', 300],
    ],
  )
})

test('classifyGap and classifyRecord distinguish VM pause, CPU contention, disk contention, memory pressure, mixed, and no-gaps', () => {
  const noGaps = classifyRecord({ version: 1, cpuCount: 4, gaps: [] })
  assert.equal(noGaps.status, 'no-gaps')
  assert.equal(noGaps.gapCount, 0)
  assert.equal(noGaps.maxGapMs, 0)

  const longPause = classifyGap({
    gapMs: 10_000,
    windowMs: 11_500,
    totalCpuGainedMs: 1_200,
    idleCpuGainedMs: 4_800,
    freeMemoryMb: 8_000,
    diskQueueLength: 0,
    topProcesses: [{ pid: 101, name: 'node', cpuGainedMs: 1_200 }],
  }, { cpuCount: 4 })
  assert.equal(longPause.kind, 'vm-pause')
  assert.ok(longPause.pausedShare >= 0.5)

  const shortPause = classifyGap({
    gapMs: 2_000,
    windowMs: 3_500,
    totalCpuGainedMs: 500,
    idleCpuGainedMs: 5_500,
    freeMemoryMb: 8_000,
    diskQueueLength: 0,
    topProcesses: [{ pid: 101, name: 'node', cpuGainedMs: 500 }],
  }, { cpuCount: 4 })
  assert.equal(shortPause.kind, 'vm-pause')

  const pauseNoIdle = classifyGap({
    gapMs: 10_000,
    windowMs: 10_000,
    totalCpuGainedMs: 40,
    idleCpuGainedMs: null,
    freeMemoryMb: 8_000,
    diskQueueLength: 0,
    topProcesses: [],
  }, { cpuCount: 4 })
  assert.equal(pauseNoIdle.kind, 'vm-pause')
  assert.equal(pauseNoIdle.pausedShare, null)

  const cpuContention = classifyGap({
    gapMs: 10_000,
    windowMs: 11_000,
    totalCpuGainedMs: 32_000,
    idleCpuGainedMs: 12_000,
    freeMemoryMb: 8_000,
    diskQueueLength: 0,
    topProcesses: [{ pid: 400, name: 'msmpeng', cpuGainedMs: 28_000 }],
  }, { cpuCount: 4 })
  assert.equal(cpuContention.kind, 'cpu-contention')
  assert.equal(cpuContention.culprit, 'msmpeng')
  assert.equal(cpuContention.culpritCpuMs, 28_000)

  const diskContention = classifyGap({
    gapMs: 4_000,
    windowMs: 5_000,
    totalCpuGainedMs: 400,
    idleCpuGainedMs: 19_600,
    freeMemoryMb: 4_096,
    diskQueueLength: 5,
    topProcesses: [{ pid: 4, name: 'system', cpuGainedMs: 400 }],
  }, { cpuCount: 4 })
  assert.equal(diskContention.kind, 'disk-contention')

  const memoryPressure = classifyGap({
    gapMs: 4_000,
    windowMs: 5_000,
    totalCpuGainedMs: 400,
    idleCpuGainedMs: 19_600,
    freeMemoryMb: 128,
    diskQueueLength: 0,
    topProcesses: [{ pid: 101, name: 'node', cpuGainedMs: 400 }],
  }, { cpuCount: 4 })
  assert.equal(memoryPressure.kind, 'memory-pressure')

  const inconclusive = classifyGap({
    gapMs: 2_000,
    windowMs: 3_000,
    totalCpuGainedMs: 400,
    idleCpuGainedMs: 11_600,
    freeMemoryMb: 4_096,
    diskQueueLength: 0,
    topProcesses: [{ pid: 101, name: 'node', cpuGainedMs: 400 }],
  }, { cpuCount: 4 })
  assert.equal(inconclusive.kind, 'inconclusive')

  const mixed = classifyRecord({
    version: 1,
    job: 'board-node24-part-1/7',
    cpuCount: 4,
    gaps: [
      {
        gapMs: 10_000,
        windowMs: 11_500,
        totalCpuGainedMs: 1_200,
        idleCpuGainedMs: 4_800,
        freeMemoryMb: 8_000,
        diskQueueLength: 0,
        topProcesses: [{ pid: 101, name: 'node', cpuGainedMs: 1_200 }],
      },
      {
        gapMs: 8_000,
        windowMs: 9_000,
        totalCpuGainedMs: 22_000,
        idleCpuGainedMs: 14_000,
        freeMemoryMb: 8_000,
        diskQueueLength: 0,
        topProcesses: [{ pid: 400, name: 'msmpeng', cpuGainedMs: 19_000 }],
      },
    ],
  })
  assert.equal(mixed.status, 'mixed')
  assert.equal(mixed.gapCount, 2)
  assert.equal(mixed.maxGapMs, 10_000)
  assert.equal(mixed.topCulprits[0].name, 'msmpeng')
  assert.equal(mixed.topCulprits[0].cpuGainedMs, 19_000)
})

test('readSamplerRecord and summarize CLI read sampler.json (with or without BOM) and fall back to gaps.ndjson', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-sampler-read-'))
  try {
    const bomDir = join(dir, 'bom')
    await mkdir(bomDir, { recursive: true })
    const sample = {
      version: 1,
      job: 'board-node24-part-3/7',
      cpuCount: 4,
      tickMs: 250,
      gapThresholdMs: 1000,
      tickCount: 20,
      totalGaps: 1,
      maxGapMs: 3200,
      gaps: [
        {
          gapMs: 3200,
          windowMs: 4200,
          totalCpuGainedMs: 200,
          idleCpuGainedMs: 1200,
          freeMemoryMb: 5120,
          diskQueueLength: 0,
          topProcesses: [{ pid: 12, name: 'node', cpuGainedMs: 200 }],
        },
      ],
    }
    await writeFile(join(bomDir, 'sampler.json'), '\uFEFF' + JSON.stringify(sample, null, 2), 'utf8')
    const parsedBom = await readSamplerRecord(bomDir)
    assert.equal(parsedBom.job, 'board-node24-part-3/7')
    assert.equal(parsedBom.gaps.length, 1)

    const classification = classifyRecord(parsedBom)
    assert.equal(classification.status, 'vm-pause')
    const markdown = formatSummary(parsedBom, classification)
    assert.match(markdown, /board-node24-part-3\/7/)
    assert.match(markdown, /vm-pause/)

    const ndjsonDir = join(dir, 'ndjson-only')
    await mkdir(ndjsonDir, { recursive: true })
    await writeFile(
      join(ndjsonDir, 'gaps.ndjson'),
      '\uFEFF' + JSON.stringify({
        gapMs: 2500,
        windowMs: 3000,
        totalCpuGainedMs: 4500,
        idleCpuGainedMs: 7500,
        freeMemoryMb: 4096,
        diskQueueLength: 1,
        topProcesses: [{ pid: 88, name: 'tiworker', cpuGainedMs: 3800 }],
      }) + '\n',
      'utf8',
    )
    const fallback = await readSamplerRecord(ndjsonDir)
    assert.equal(fallback.incomplete, true)
    assert.equal(fallback.gaps.length, 1)
    assert.equal(classifyRecord(fallback).status, 'cpu-contention')

    const ok = spawnSync(process.execPath, [samplerMjs, 'summarize', bomDir], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /vm-pause/)

    const missing = spawnSync(process.execPath, [samplerMjs, 'summarize', join(dir, 'does-not-exist')], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(missing.status, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Windows runner sampler starts detached, stops cleanly, and captures real counters on a synthetic gap', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only live sampler test')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'ab-win-sampler-'))
  const dirA = join(root, 'detached-run')
  const dirB = join(root, 'gap-run')
  const githubOutput = join(root, 'github_output.txt')
  const githubSummary = join(root, 'github_summary.md')
  await writeFile(githubOutput, '', 'utf8')
  await writeFile(githubSummary, '', 'utf8')
  let detachedPid = null

  let failed = false
  try {
    // Part A: detached start returns fast without pipe hang, then stop flushes sampler.json and writes summary.
    const startedAt = Date.now()
    const startRes = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        samplerPs1,
        '-Action',
        'start',
        '-JobName',
        'live-test-part-1/2',
        '-Dir',
        dirA,
        '-TickMs',
        '100',
        '-GapMs',
        '5000',
        '-BaselineMs',
        '400',
        '-MaxDurationSec',
        '25',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      },
    )
    const startElapsed = Date.now() - startedAt
    assert.ifError(startRes.error)
    assert.equal(startRes.status, 0, startRes.stdout + '\n' + startRes.stderr)
    assert.ok(startElapsed < 12_000, `start step took too long: ${startElapsed} ms`)

    const outputText = await readFile(githubOutput, 'utf8')
    assert.match(outputText, new RegExp(`dir=${dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(outputText, /artifact=windows-sampler-live-test-part-1-of-2/)

    const pidInfo = JSON.parse((await readFile(join(dirA, 'sampler.pid.json'), 'utf8')).replace(/^\uFEFF/, ''))
    assert.equal(typeof pidInfo.pid, 'number')
    detachedPid = pidInfo.pid

    const stopRes = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        samplerPs1,
        '-Action',
        'stop',
        '-Dir',
        dirA,
        '-StopTimeoutMs',
        '8000',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, GITHUB_STEP_SUMMARY: githubSummary },
      },
    )
    assert.ifError(stopRes.error)
    assert.equal(stopRes.status, 0, stopRes.stdout + '\n' + stopRes.stderr)
    assert.equal(existsSync(join(dirA, 'sampler.json')), true)
    const stoppedRecord = await readSamplerRecord(dirA)
    assert.equal(stoppedRecord.version, 1)
    assert.ok(stoppedRecord.cpuCount >= 1)
    assert.equal(stoppedRecord.tickMs, 100)
    assert.equal(stoppedRecord.gapThresholdMs, 5000)

    const summaryText = await readFile(githubSummary, 'utf8')
    assert.match(summaryText, /Windows runner sampler/)

    // Part B: real PerformanceCounter capture when a tick exceeds GapMs.
    const gapRes = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        samplerPs1,
        '-Action',
        'run',
        '-JobName',
        'gap-test',
        '-Dir',
        dirB,
        '-TickMs',
        '120',
        '-GapMs',
        '50',
        '-BaselineMs',
        '200',
        '-MaxTicks',
        '3',
        '-MaxDurationSec',
        '25',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 25_000,
      },
    )
    assert.ifError(gapRes.error)
    assert.equal(gapRes.status, 0, gapRes.stdout + '\n' + gapRes.stderr)
    const gapRecord = await readSamplerRecord(dirB)
    assert.ok(gapRecord.totalGaps >= 1, JSON.stringify(gapRecord))
    assert.ok(gapRecord.gaps.length >= 1)
    const firstGap = gapRecord.gaps[0]
    assert.ok(firstGap.gapMs >= 50)
    assert.ok(firstGap.freeMemoryBytes > 0)
    assert.equal(typeof firstGap.diskQueueLength, 'number')
    assert.ok(firstGap.diskQueueLength >= 0)
    assert.equal(typeof firstGap.totalCpuGainedMs, 'number')
    assert.ok(firstGap.totalCpuGainedMs >= 0)
    assert.ok(firstGap.processCount > 0)
    assert.ok(Array.isArray(firstGap.topProcesses))

    const ndjsonLines = (await readFile(join(dirB, 'gaps.ndjson'), 'utf8'))
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
    assert.ok(ndjsonLines.length >= 1)
    assert.ok(JSON.parse(ndjsonLines[0]).gapMs >= 50)
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (detachedPid !== null) {
      try { process.kill(detachedPid) } catch {}
    }
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (rmError) {
      if (!failed) throw rmError
    }
  }
})

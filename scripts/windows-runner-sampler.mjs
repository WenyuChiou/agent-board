import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_ARTIFACT_NAME_LENGTH = 100

export const sanitizeArtifactName = jobName => {
  const raw = typeof jobName === 'string' ? jobName : String(jobName ?? '')
  const slug = raw.replace(/\//g, '-of-').toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'job'
  return ('windows-sampler-' + slug).slice(0, MAX_ARTIFACT_NAME_LENGTH).replace(/[.-]+$/g, '')
}

const normalizeProcName = name => String(name ?? '').replace(/#\d+$/, '').toLowerCase()
const procKey = entry => `${entry.pid}:${entry.createdRaw ?? 0}`

export const computeCpuDeltas = (beforeProcesses = [], afterProcesses = []) => {
  const beforeMap = new Map()
  for (const entry of beforeProcesses ?? []) {
    if (!entry) continue
    const name = normalizeProcName(entry.name)
    if (name !== '_total') beforeMap.set(procKey(entry), Number(entry.cpuMs) || 0)
  }
  let idleCpuGainedMs = 0
  let hasIdle = false
  let totalCpuGainedMs = 0
  const processes = []
  for (const entry of afterProcesses ?? []) {
    if (!entry) continue
    const name = normalizeProcName(entry.name)
    if (name === '_total') continue
    const delta = Math.max(0, Math.round((Number(entry.cpuMs) || 0) - (beforeMap.get(procKey(entry)) ?? 0)))
    if (entry.pid === 0 || name === 'idle') {
      idleCpuGainedMs += delta
      hasIdle = true
    } else if (delta > 0) {
      totalCpuGainedMs += delta
      processes.push({ pid: entry.pid, name, cpuGainedMs: delta })
    }
  }
  processes.sort((a, b) => b.cpuGainedMs - a.cpuGainedMs || a.pid - b.pid)
  return { totalCpuGainedMs, idleCpuGainedMs: hasIdle ? idleCpuGainedMs : null, processes }
}

export const classifyGap = (gap, { cpuCount = 4 } = {}) => {
  const gapMs = Math.max(0, Number(gap?.gapMs) || 0)
  const windowMs = Math.max(Number(gap?.windowMs) || gapMs, gapMs)
  const totalCpuGainedMs = Math.max(0, Number(gap?.totalCpuGainedMs) || 0)
  const idleRaw = gap?.idleCpuGainedMs
  const hasIdle = typeof idleRaw === 'number' && Number.isFinite(idleRaw) && idleRaw >= 0
  const cores = Math.max(1, Number(cpuCount) || 4)
  const topProcesses = Array.isArray(gap?.topProcesses) ? gap.topProcesses : gap?.topProcesses ? [gap.topProcesses] : []
  const topProcess = topProcesses[0] ?? null
  const share = hasIdle && gapMs > 0 ? Math.max(0, cores * windowMs - (totalCpuGainedMs + idleRaw)) / (cores * gapMs) : null
  const pausedShare = share === null ? null : Number(share.toFixed(3))

  if (hasIdle && share >= 0.5 && totalCpuGainedMs < gapMs * 0.5) {
    return { kind: 'vm-pause', pausedShare, reason: `missing ~${Math.round(share * 100)}% of expected ${cores}-core capacity (${totalCpuGainedMs} ms active, ${idleRaw} ms idle across ${windowMs} ms window)` }
  }
  if (totalCpuGainedMs >= gapMs * 0.5 && topProcess) {
    return { kind: 'cpu-contention', culprit: topProcess.name, culpritCpuMs: topProcess.cpuGainedMs, pausedShare, reason: `active CPU gained ${totalCpuGainedMs} ms during ${gapMs} ms gap (top: ${topProcess.name} ${topProcess.cpuGainedMs} ms)` }
  }
  if (typeof gap?.diskQueueLength === 'number' && gap.diskQueueLength >= 2) {
    return { kind: 'disk-contention', diskQueueLength: gap.diskQueueLength, pausedShare, reason: `disk queue length ${gap.diskQueueLength} during ${gapMs} ms gap` }
  }
  if (typeof gap?.freeMemoryMb === 'number' && gap.freeMemoryMb < 256) {
    return { kind: 'memory-pressure', freeMemoryMb: gap.freeMemoryMb, pausedShare, reason: `free memory dropped to ${gap.freeMemoryMb} MB during ${gapMs} ms gap` }
  }
  if (!hasIdle && gapMs > 0 && totalCpuGainedMs < gapMs * 0.25) {
    return { kind: 'vm-pause', pausedShare: null, reason: `only ${totalCpuGainedMs} ms active CPU gained across ${gapMs} ms gap (idle counter unavailable)` }
  }
  return { kind: 'inconclusive', pausedShare, reason: `gap ${gapMs} ms (${totalCpuGainedMs} ms active CPU, diskQ=${gap?.diskQueueLength ?? 'n/a'}, freeMB=${gap?.freeMemoryMb ?? 'n/a'})` }
}

export const classifyRecord = record => {
  const cpuCount = Math.max(1, Number(record?.cpuCount) || 4)
  const rawGaps = Array.isArray(record?.gaps) ? record.gaps : record?.gaps ? [record.gaps] : []
  const gaps = rawGaps.map(gap => ({ ...gap, classification: classifyGap(gap, { cpuCount }) }))
  const kinds = [...new Set(gaps.map(gap => gap.classification.kind))]
  const status = !gaps.length ? 'no-gaps' : kinds.length === 1 ? kinds[0] : 'mixed'
  const maxGapMs = gaps.reduce((max, gap) => Math.max(max, Number(gap.gapMs) || 0), 0)
  const byProc = new Map()
  for (const gap of gaps) {
    const procs = Array.isArray(gap.topProcesses) ? gap.topProcesses : gap.topProcesses ? [gap.topProcesses] : []
    for (const proc of procs) {
      if (!proc?.name) continue
      const key = String(proc.name).toLowerCase()
      byProc.set(key, (byProc.get(key) ?? 0) + (Number(proc.cpuGainedMs) || 0))
    }
  }
  const topCulprits = [...byProc.entries()].map(([name, cpuGainedMs]) => ({ name, cpuGainedMs })).sort((a, b) => b.cpuGainedMs - a.cpuGainedMs).slice(0, 10)
  return { status, gapCount: gaps.length, maxGapMs, kinds, gaps, topCulprits }
}

const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
const parseNdjson = text => ({ version: 1, incomplete: true, cpuCount: 4, gaps: text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)) })

export const readSamplerRecord = async targetPath => {
  const resolved = resolve(targetPath)
  const info = await stat(resolved)
  if (info.isDirectory()) {
    const jsonPath = join(resolved, 'sampler.json')
    if (existsSync(jsonPath)) return JSON.parse(stripBom(await readFile(jsonPath, 'utf8')))
    const ndjsonPath = join(resolved, 'gaps.ndjson')
    if (existsSync(ndjsonPath)) return parseNdjson(stripBom(await readFile(ndjsonPath, 'utf8')))
    throw new Error(`no sampler.json or gaps.ndjson found in ${resolved}`)
  }
  const text = stripBom(await readFile(resolved, 'utf8'))
  return resolved.endsWith('.ndjson') ? parseNdjson(text) : JSON.parse(text)
}

export const formatSummary = (record, classification = classifyRecord(record)) => {
  const lines = [
    `### Windows runner sampler: ${record?.job ?? 'unknown-job'}`,
    `- Status: \`${classification.status}\` (${classification.gapCount} gaps > ${record?.gapThresholdMs ?? 1000} ms, max ${classification.maxGapMs} ms, cpuCount=${record?.cpuCount ?? 'n/a'}${record?.incomplete ? ', incomplete/ndjson fallback' : ''})`,
  ]
  if (classification.topCulprits.length) {
    lines.push(`- Top CPU consumers across gaps: ${classification.topCulprits.slice(0, 5).map(c => `\`${c.name}\` (${c.cpuGainedMs} ms)`).join(', ')}`)
  }
  classification.gaps.forEach((g, i) => {
    const top = Array.isArray(g.topProcesses) && g.topProcesses[0] ? `, top=\`${g.topProcesses[0].name}\` (${g.topProcesses[0].cpuGainedMs} ms)` : ''
    lines.push(`- Gap #${i + 1}: **${g.classification.kind}** (${g.gapMs} ms, window ${g.windowMs ?? g.gapMs} ms, freeMem=${g.freeMemoryMb ?? 'n/a'} MB, diskQ=${g.diskQueueLength ?? 'n/a'}${top}) — ${g.classification.reason}`)
  })
  return lines.join('\n')
}

const main = async () => {
  const [command, target] = process.argv.slice(2)
  if (command !== 'summarize' || !target) { console.error('usage: node scripts/windows-runner-sampler.mjs summarize <path>'); return 1 }
  const record = await readSamplerRecord(target)
  console.log(formatSummary(record, classifyRecord(record)))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(err => { console.error(err?.message ?? String(err)); process.exitCode = 1 })
}

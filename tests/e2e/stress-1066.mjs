import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'
import { stopTree } from './lib/processes.mjs'

// #1066 measurement, for the measurement-only branch (no pull request): the full hook load
// (tests/e2e/hook-load.mjs, 30 sessions for 10 minutes on CI) runs while the runner is starved, and
// this script watches what the board starts and leaves behind. It never runs per pull request.
//   node tests/e2e/stress-1066.mjs --condition none|cpu|memory|disk|kill [--out DIR]
//   none    a baseline on the same runner
//   cpu     one busy Node loop per logical CPU, plus one
//   memory  a Node process that keeps free memory near 768 MB (never past 85 % of the machine)
//   disk    Linux only: the hook load and a direct-I/O writer run in a cgroup whose io.max is 512 KB/s and 20 IOPS
//           on the device under the temp folder. An approximation of a stalled disk; a 30 s device stall needs a VM.
//   kill    every 3 s (6 s on Windows) one random live board process of the load, page server excluded, gets SIGKILL
// Stress conditions run only on a GitHub runner or a VM, never on a person's own computer (#1066 bounds).

const args = process.argv.slice(2)
const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const condition = value('--condition') ?? 'none'
const out = resolve(value('--out') ?? 'stress-report')
const CONDITIONS = ['none', 'cpu', 'memory', 'disk', 'kill']
if (!CONDITIONS.includes(condition)) { process.stderr.write(`unknown condition ${condition}\n`); process.exit(2) }
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const SAMPLE_MS = 15000
// Linux lists /proc in a few ms; a Windows list is one PowerShell start (1–2 s), so it is rarer there.
const KILL_MS = isWindows ? 6000 : 1000
const HOOK_LOAD_LIMIT_MS = 15 * 60000
const MEMORY_FLOOR = 768 * 1048576
const MEMORY_SHARE = 0.85
const firstLine = error => String(error?.message ?? error).split(/\r?\n/)[0]
const t0 = performance.now()
const since = () => Math.round(performance.now() - t0)

const report = {
  condition, os: process.platform, node: process.version, cpus: availableParallelism(), totalMB: Math.round(totalmem() / 1048576),
  startedAt: new Date().toISOString(), status: 'running', stressor: { applied: false, detail: '' }, kills: 0,
  samples: [], peaks: { boardProcesses: 0, boardRssMB: 0, worldTmpFiles: 0, worldLockFiles: 0 }, hookLoad: undefined, notes: [],
}
const note = text => { if (report.notes.length < 20 && !report.notes.includes(text)) report.notes.push(text) }
const save = () => {
  mkdirSync(out, { recursive: true })
  const file = join(out, 'stress.json'), temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  for (let attempt = 1; ; attempt += 1) {
    try { renameSync(temporary, file); return } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) { try { unlinkSync(temporary) } catch {}; throw error }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}
const say = text => process.stdout.write(`stress ${condition}: ${text}\n`)

const world = makeWorld()
const roots = [world.root, realpathSync.native(world.root)]
const inWorld = command => roots.some(root => command.includes(root))
const children = []
const child = (file, argv, options = {}) => {
  const one = spawnIsolated(file, argv, { env: world.env, cwd: world.root, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  one.stdin?.on('error', () => {})
  one.stderr?.setEncoding('utf8').on('data', text => { one.lastError = (String(one.lastError ?? '') + text).slice(-400) })
  one.on('error', error => note(`${file} could not start: ${firstLine(error)}`))
  children.push(one)
  return one
}
const sh = (command, timeoutMs = 20000) => new Promise(done => {
  const one = spawnIsolated('/bin/sh', ['-c', command], { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  one.stdout.setEncoding('utf8').on('data', t => { stdout += t })
  one.stderr.setEncoding('utf8').on('data', t => { stderr += t })
  const timer = setTimeout(() => one.kill('SIGKILL'), timeoutMs)
  one.once('close', code => { clearTimeout(timer); done({ code, stdout: stdout.trim(), stderr: stderr.trim() }) })
  one.once('error', error => { clearTimeout(timer); done({ code: -1, stdout: '', stderr: firstLine(error) }) })
})

// The processes of this run: everything whose command names the world (the hook load's own world
// lives in this world's temp folder, so its page server and hook children count too).
const listProcesses = async () => {
  if (isLinux) {
    const list = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ')
        if (!inWorld(command)) continue
        const rssPages = Number(readFileSync(`/proc/${entry}/statm`, 'utf8').split(' ')[1])
        list.push({ pid: Number(entry), command, rssMB: Math.round(rssPages * 4096 / 1048576) })
      } catch {}
    }
    return list
  }
  if (isWindows) {
    const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*agent-board-e2e-*" } | Select-Object ProcessId,CommandLine,WorkingSetSize | ConvertTo-Json -Compress'
    const one = spawnIsolated('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    one.stdout.setEncoding('utf8').on('data', t => { stdout += t })
    const timer = setTimeout(() => one.kill('SIGKILL'), 60000)
    await new Promise(done => one.once('close', done))
    clearTimeout(timer)
    try {
      return [JSON.parse(stdout || '[]')].flat().filter(Boolean).map(p => ({ pid: p.ProcessId, command: p.CommandLine ?? '', rssMB: Math.round((p.WorkingSetSize ?? 0) / 1048576) })).filter(p => inWorld(p.command))
    } catch { return [] }
  }
  const { stdout } = await new Promise(done => {
    const one = spawnIsolated('ps', ['-axww', '-o', 'pid=,rss=,command='], { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    one.stdout.setEncoding('utf8').on('data', t => { text += t })
    one.once('close', () => done({ stdout: text }))
  })
  return stdout.split('\n').flatMap(line => {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return found && inWorld(found[3]) ? [{ pid: Number(found[1]), command: found[3], rssMB: Math.round(Number(found[2]) / 1024) }] : []
  })
}
const isBoardProcess = p => /agent-board(?:-hook)?\.mjs|board-script|--serve-child/.test(p.command) && !/stress-1066\.mjs|hook-load\.mjs/.test(p.command)
const isPageServer = p => p.command.includes('--serve-child')
// The page server, and the --serve start that launches it, are never killed: the load needs its page.
const isServe = p => p.command.includes('--serve')
// The killer starts once the page server is up and every host's warm-up hook has run.
const KILL_START_MS = 60000

// Files that should not outlive a write: temps, locks and recovery gates in the load's own world.
const worldFiles = () => {
  const result = { tmp: 0, lock: 0 }
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) { if (!/node_modules/.test(entry.name)) walk(file); continue }
      if (/\.tmp$|\.taking$/.test(entry.name)) result.tmp += 1
      if (/lock|\.recover$|\.owner$/.test(entry.name)) result.lock += 1
    }
  }
  walk(join(world.root, 'tmp'))
  return result
}

// Stressors.
let cgroup
const startStressor = async () => {
  if (condition === 'cpu') {
    const count = availableParallelism() + 1
    for (let i = 0; i < count; i++) child(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' })
    report.stressor = { applied: true, detail: `${count} busy Node loops` }
  } else if (condition === 'memory') {
    const hog = `const os = require('node:os'); const held = []; let bytes = 0
const chunk = 64 * 1048576, cap = Math.floor(os.totalmem() * ${MEMORY_SHARE})
const top = () => { let n = 0; while (os.freemem() > ${MEMORY_FLOOR} && bytes + chunk <= cap && n < 64) { held.push(Buffer.alloc(chunk, 1)); bytes += chunk; n += 1 } process.stdout.write('held ' + Math.round(bytes / 1048576) + ' MB free ' + Math.round(os.freemem() / 1048576) + ' MB\\n') }
top(); setInterval(top, 5000); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`
    const one = child(process.execPath, ['-e', hog])
    let last = ''
    one.stdout.setEncoding('utf8').on('data', text => { last = text.trim().split('\n').pop(); report.stressor.detail = last })
    await new Promise(done => setTimeout(done, 3000))
    report.stressor = { applied: one.exitCode === null, detail: last || 'no report from the memory hog' }
  } else if (condition === 'disk') {
    if (!isLinux) { report.stressor = { applied: false, detail: 'disk throttling is Linux only' }; return }
    // io.max takes the whole disk's MAJ:MIN, not a partition's (writing 8:1 there says "No such device").
    const source = (await sh(`findmnt -no SOURCE -T ${JSON.stringify(world.root)}`)).stdout.split('\n')[0].replace(/\[.*$/, '')
    const parent = (await sh(`lsblk -no PKNAME ${JSON.stringify(source)} 2>/dev/null | head -1`)).stdout
    const device = (await sh(`lsblk -dno MAJ:MIN ${JSON.stringify(parent ? `/dev/${parent}` : source)}`)).stdout.trim()
    if (!/^\d+:\d+$/.test(device)) { report.stressor = { applied: false, detail: `no device for the temp folder (source ${source || 'empty'}, parent ${parent || 'none'}, got ${device || 'empty'})` }; return }
    cgroup = '/sys/fs/cgroup/ab1066'
    const setup = await sh(`sudo -n mkdir -p ${cgroup} && echo '+io' | sudo -n tee /sys/fs/cgroup/cgroup.subtree_control >/dev/null; echo '${device} rbps=524288 wbps=524288 riops=20 wiops=20' | sudo -n tee ${cgroup}/io.max`)
    if (setup.code !== 0) { report.stressor = { applied: false, detail: `io.max could not be set on ${device}: ${setup.stderr || setup.stdout}` }; cgroup = undefined; return }
    // A writer in the same cgroup keeps the throttled queue full, so the board's own writes wait behind it.
    const writer = child('/bin/sh', ['-c', `echo $$ | sudo -n tee ${cgroup}/cgroup.procs >/dev/null; while true; do dd if=/dev/zero of=${world.root}/tmp/fill bs=1M count=64 oflag=direct conv=fsync 2>/dev/null; rm -f ${world.root}/tmp/fill; done`], { stdio: 'ignore' })
    report.stressor = { applied: true, detail: `cgroup io.max ${device} 512 KB/s, 20 IOPS; direct-I/O writer pid ${writer.pid}` }
  } else if (condition === 'kill') {
    report.stressor = { applied: true, detail: `one random board process (page server excluded) gets SIGKILL every ${KILL_MS / 1000} s; a process list on Windows takes 1–2 s itself, so short hook children are hit rarely there` }
  }
}
const joinCgroup = async pid => {
  if (!cgroup) return
  const moved = await sh(`echo ${pid} | sudo -n tee ${cgroup}/cgroup.procs >/dev/null && cat /proc/${pid}/cgroup`)
  report.stressor.detail += moved.code === 0 ? `; hook load in ${moved.stdout}` : `; hook load NOT moved: ${moved.stderr}`
}
const stopStressor = async () => {
  for (const one of children) { try { one.stdin?.end() } catch {}; try { one.kill('SIGKILL') } catch {} }
  if (cgroup) await sh(`sleep 1; sudo -n rmdir ${cgroup} 2>&1 || true`)
}

// The run.
const main = async () => {
  say(`${report.cpus} CPUs, ${report.totalMB} MB; out ${out}`)
  await startStressor()
  say(`stressor: ${report.stressor.applied ? 'applied' : 'not applied'} (${report.stressor.detail})`)
  save()
  const folder = join(out, 'hook-load')
  const env = Object.fromEntries(Object.entries(world.env).filter(([name]) => name !== 'NODE_OPTIONS' && !name.startsWith('E2E_')))
  for (const name of ['CI', 'AGENT_BOARD_HEAVY_TESTS']) if (process.env[name] !== undefined) env[name] = process.env[name]
  const load = child(process.execPath, [fileURLToPath(new URL('./hook-load.mjs', import.meta.url)), '--out', folder, '--stop-on-stdin'], { env })
  await joinCgroup(load.pid)
  let carry = ''
  load.stdout.setEncoding('utf8').on('data', chunk => {
    const lines = (carry + chunk).split('\n'); carry = lines.pop()
    for (const line of lines) if (line.trim()) process.stdout.write(`hook-load: ${line.trim().replace(/^hook load: /, '')}\n`)
  })
  const deadline = setTimeout(() => { note('The hook load passed its 15-minute limit and was told to stop.'); load.stdin.end('stop\n') }, HOOK_LOAD_LIMIT_MS)

  const sample = async () => {
    const started = performance.now()
    let list = []
    try { list = await listProcesses() } catch (error) { note(`A process sample failed: ${firstLine(error)}`) }
    const board = list.filter(isBoardProcess)
    const files = worldFiles()
    const one = { at: since(), listMs: Math.round(performance.now() - started), boardProcesses: board.length, boardRssMB: board.reduce((sum, p) => sum + p.rssMB, 0), pageServerRssMB: board.filter(isPageServer).reduce((sum, p) => sum + p.rssMB, 0), allProcesses: list.length, freeMB: Math.round(freemem() / 1048576), load1: isWindows ? undefined : Number(loadavg()[0].toFixed(1)), tmpFiles: files.tmp, lockFiles: files.lock }
    report.samples.push(one)
    report.peaks.boardProcesses = Math.max(report.peaks.boardProcesses, one.boardProcesses)
    report.peaks.boardRssMB = Math.max(report.peaks.boardRssMB, one.boardRssMB)
    report.peaks.worldTmpFiles = Math.max(report.peaks.worldTmpFiles, one.tmpFiles)
    report.peaks.worldLockFiles = Math.max(report.peaks.worldLockFiles, one.lockFiles)
    try { save() } catch (error) { note(`The report could not be saved: ${firstLine(error)}`) }
    return board
  }
  const sampler = setInterval(() => { void sample() }, SAMPLE_MS)
  let killer, killerStart
  if (condition === 'kill') {
    killerStart = setTimeout(() => {
      killer = setInterval(async () => {
        let list = []
        try { list = (await listProcesses()).filter(p => isBoardProcess(p) && !isServe(p)) } catch { return }
        if (list.length === 0) return
        const victim = list[Math.floor(Math.random() * list.length)]
        try { process.kill(victim.pid, 'SIGKILL'); report.kills += 1; report.killed = [...(report.killed ?? []).slice(-19), { at: since(), command: victim.command.replace(/\S*agent-board-e2e-[^\s\\/]*/g, '<world>').slice(0, 120) }] } catch {}
      }, KILL_MS)
    }, KILL_START_MS)
  }

  const { code, signal } = await new Promise(done => load.once('close', (code, signal) => done({ code, signal })))
  clearTimeout(deadline); clearInterval(sampler); clearTimeout(killerStart); clearInterval(killer)
  await sample()
  report.hookLoadExit = signal ?? code
  if (load.lastError) note(`hook load stderr: ${load.lastError.trim().split('\n').pop()}`)
  try {
    const found = JSON.parse(readFileSync(join(folder, 'hook-load.json'), 'utf8'))
    report.hookLoad = { mode: found.mode, sessions: found.sessions, seconds: found.seconds, status: found.status, stats: found.stats, checks: found.checks, notes: found.notes }
  } catch (error) { note(`hook-load.json could not be read: ${firstLine(error)}`) }
  await stopStressor()
  // What is still alive 30 s after the load ended, from this run's world.
  await new Promise(done => setTimeout(done, 30000))
  const left = (await listProcesses().catch(() => [])).filter(isBoardProcess)
  report.leftAfter30s = left.map(p => ({ pid: p.pid, rssMB: p.rssMB, command: p.command.replace(/\S*agent-board-e2e-[^\s\\/]*/g, '<world>').slice(0, 160) }))
  report.status = 'finished'
  report.finishedAt = new Date().toISOString()
  save()
  const s = report.hookLoad?.stats
  const lines = [
    `# #1066 stress: ${condition} on ${process.platform}`, '',
    `Stressor: ${report.stressor.applied ? 'applied' : 'NOT applied'} (${report.stressor.detail}). Kills: ${report.kills}.`,
    s ? `Hook runs ${s.runs}: p50 ${s.hooks.p50} ms, p95 ${s.hooks.p95} ms, max ${s.hooks.max} ms. Page shown p50 ${s.page.p50} ms, late ${s.page.late}, missed ${s.page.missed}. Queued peak ${s.peaks.queued}. Hook errors ${JSON.stringify(s.hookErrors)}.` : 'No hook-load stats.',
    `Board processes peak ${report.peaks.boardProcesses}, their RSS peak ${report.peaks.boardRssMB} MB; temp files peak ${report.peaks.worldTmpFiles}, lock files peak ${report.peaks.worldLockFiles}; left after 30 s: ${left.length}.`,
    '', ...(report.hookLoad?.checks ?? []).map(c => `- ${c.status.toUpperCase()} ${c.title.replace('L6 hook load: ', '')}: ${c.line ?? ''}`),
    '', ...report.notes.map(n => `- note: ${n}`),
  ]
  writeFileSync(join(out, 'stress.md'), lines.join('\n') + '\n')
  say(lines.slice(2, 5).join(' | '))
  // A load that did not run to its end is a failed measurement, whatever the checks say.
  return report.hookLoad?.status === 'finished' ? 0 : 1
}

let exitCode = 1
try { exitCode = await main() } catch (error) {
  note(`The run failed: ${firstLine(error)}`)
  report.status = 'failed'
  try { save() } catch {}
} finally {
  await stopStressor().catch(() => {})
  try { await stopTree({ spawnIsolated, makeWorld, rootPid: process.pid, roots }) } catch {}
  try { await world.close() } catch {}
}
process.exit(exitCode)

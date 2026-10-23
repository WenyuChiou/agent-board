import { readFileSync, readdirSync } from 'node:fs'
import { leftoverProcesses } from './soak-report.mjs'

const processOutput = async ({ spawnIsolated, world, file, args, timeoutMs, problem }) => {
  const child = spawnIsolated(file, args, { env: world.env, cwd: world.root, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  let size = 0, isTooBig = false, isTimedOut = false, errorText = ''
  child.stdout.on('data', chunk => {
    size += chunk.length
    if (size > 64 * 1048576) { isTooBig = true; child.kill('SIGKILL') } else chunks.push(chunk)
  })
  child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString('utf8')).slice(0, 4096) })
  // A world's fresh profile folders give PowerShell a cold start.
  const timer = setTimeout(() => { isTimedOut = true; child.kill('SIGKILL') }, timeoutMs)
  const status = await new Promise(done => {
    child.once('error', error => done(error.code ?? 'error'))
    child.once('close', (code, signal) => done(isTooBig ? 'over 64 MB of output' : isTimedOut ? `no answer in ${timeoutMs / 1000} s` : signal ? `stopped by ${signal}` : code === 0 ? 0 : `exit ${code}`))
  })
  clearTimeout(timer)
  if (status !== 0) throw new Error(`${problem} (${status})${errorText.trim() ? `: ${errorText.trim()}` : ''}`)
  return { stdout: Buffer.concat(chunks).toString('utf8'), pid: child.pid }
}

// Every process running now, with its creation time where available, and the lister's own pid. The
// lister starts as every e2e child does, inside a world (lib/spawn.mjs); Linux reads /proc instead.
export const processList = async ({ spawnIsolated, world, timeoutMs = 60000 }) => {
  if (process.platform === 'linux') {
    const list = []
    const deadline = Date.now() + timeoutMs
    for (const entry of readdirSync('/proc')) {
      if (Date.now() >= deadline) throw new Error(`the process list could not be read (no answer in ${timeoutMs / 1000} s)`)
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        const fields = stat.slice(close + 2).split(' ')
        if (fields[0] === 'Z') continue
        list.push({ pid: Number(entry), ppid: Number(fields[1]), started: Number(fields[19]), name: stat.slice(stat.indexOf('(') + 1, close), command: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ') })
      } catch {}
    }
    return { list }
  }
  const isWindows = process.platform === 'win32'
  const [file, args] = isWindows
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name="started";Expression={if ($null -ne $_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}} | ConvertTo-Json -Compress']]
    : ['ps', ['-axww', '-o', 'pid=,ppid=,comm=,command=']]
  const { stdout, pid } = await processOutput({ spawnIsolated, world, file, args, timeoutMs, problem: 'the process list could not be read' })
  const list = isWindows
    ? [JSON.parse(stdout)].flat().map(one => ({ pid: one.ProcessId, ppid: one.ParentProcessId, started: typeof one.started === 'number' ? one.started : undefined, name: one.Name ?? '', command: one.CommandLine ?? '' }))
    : stdout.split('\n').flatMap(line => {
      const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return found ? [{ pid: Number(found[1]), ppid: Number(found[2]), name: found[3], command: found[4] }] : []
    })
  return { list, lister: pid }
}

// Kill descendants and orphaned workers before the root, except when the caller is that root.
// Creation times are checked before killing, and distinguish survivors from reused pids afterwards.
export const stopTree = async ({ spawnIsolated, makeWorld, rootPid, isRootAlive = () => true, roots, exclude = [], timeoutMs = 20000 }) => {
  let world
  const deadline = Date.now() + timeoutMs
  try {
    if (process.platform !== 'linux') world = makeWorld()
    const { list, lister } = await processList({ spawnIsolated, world, timeoutMs: Math.max(1, deadline - Math.ceil(timeoutMs / 2) - Date.now()) })
    const liveRoot = rootPid !== undefined && isRootAlive() ? rootPid : undefined
    if (!list.some(one => one.pid === process.pid)) throw new Error('the process list did not include this run')
    const excluded = lister === undefined ? exclude : [...exclude, lister]
    const left = leftoverProcesses({ list, self: liveRoot, roots, exclude: excluded })
    const root = list.find(one => one.pid === liveRoot)
    const targets = [...left, ...(root === undefined || excluded.includes(root.pid) ? [] : [root])].filter(one => one.pid > 0 && one.pid !== process.pid)
    const countNames = processes => processes.reduce((counts, one) => {
      const name = one.name.split(/[\\/]/).at(-1)
      counts[name] = (counts[name] ?? 0) + 1
      return counts
    }, {})
    const sent = []
    const killDeadline = Math.min(deadline - Math.ceil(timeoutMs / 4), Date.now() + Math.floor(timeoutMs / 4))
    if (process.platform === 'win32') {
      const pairs = targets.filter(one => Number.isSafeInteger(one.pid) && Number.isSafeInteger(one.started)).map(one => [one.pid, one.started])
      try {
        if (pairs.length > 0) {
          const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; $targets = ConvertFrom-Json '${JSON.stringify({ pairs })}'; $stopped = @(foreach ($pair in $targets.pairs) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pair[0]) | ForEach-Object { if ($null -ne $_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -eq $pair[1]) { $result = Invoke-CimMethod -InputObject $_ -MethodName Terminate; if ($result.ReturnValue -eq 0) { $pair[0] } } } }); ConvertTo-Json -InputObject $stopped -Compress`
          const { stdout } = await processOutput({ spawnIsolated, world, file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command], timeoutMs: Math.max(1, killDeadline - Date.now()), problem: 'the process tree could not be stopped' })
          const killed = JSON.parse(stdout)
          if (!Array.isArray(killed) || !killed.every(pid => pairs.some(pair => pair[0] === pid))) throw new Error('the process tree returned invalid killed pids')
          sent.push(...targets.filter(one => killed.includes(one.pid)))
        }
      } catch (error) {
        return { stopped: 0, remaining: undefined, names: {}, unchecked: String(error?.message ?? error).split('\n')[0] }
      }
    } else {
      for (const one of targets) {
        if (Date.now() >= killDeadline) break
        try {
          if (process.platform === 'linux') {
            if (one.started === undefined) continue
            const stat = readFileSync(`/proc/${one.pid}/stat`, 'utf8')
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
            if (fields[0] === 'Z' || Number(fields[19]) !== one.started) continue
          }
          // macOS ps has no start times, so it keeps the plain pid kill.
          process.kill(one.pid, 'SIGKILL')
          sent.push(one)
        } catch {}
      }
    }
    await new Promise(done => setTimeout(done, Math.min(300, Math.max(0, deadline - Date.now()))))
    let after
    try {
      after = await processList({ spawnIsolated, world, timeoutMs: Math.max(1, deadline - Date.now()) })
      if (!after.list.some(one => one.pid === process.pid)) throw new Error('the process list did not include this run')
    } catch (error) {
      return { stopped: sent.length, remaining: undefined, names: countNames(sent), unchecked: String(error?.message ?? error).split('\n')[0] }
    }
    const isAlive = one => after.list.some(next => next.pid === one.pid && (one.started === undefined || next.started === undefined || next.started === one.started))
    const stopped = sent.filter(one => !isAlive(one))
    const remaining = new Set(targets.filter(isAlive).map(one => one.pid))
    const currentRoot = after.list.find(one => one.pid === liveRoot)
    const isRootReused = currentRoot !== undefined && (root === undefined || root.started !== undefined && currentRoot.started !== undefined && root.started !== currentRoot.started)
    for (const one of leftoverProcesses({ list: after.list, self: isRootReused ? -1 : liveRoot, roots, exclude: after.lister === undefined ? exclude : [...exclude, after.lister] })) {
      if (one.pid !== process.pid) remaining.add(one.pid)
    }
    return { stopped: stopped.length, remaining: remaining.size, names: countNames(stopped) }
  } finally { await world?.close() }
}

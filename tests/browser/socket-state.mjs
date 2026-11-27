import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Chromium's names for a socket the system would not give it. On Windows ERR_NO_BUFFER_SPACE is WSAENOBUFS: the
// runner ran out of ephemeral ports or socket buffers, not something the page did (#1810).
export const SOCKET_LIMIT = /net::ERR_(NO_BUFFER_SPACE|ADDRESS_IN_USE|INSUFFICIENT_RESOURCES)\b/

// Counts `netstat -ano -p tcp` rows by state, and the loopback ones by state and by owning process id, so a
// failure's evidence says whether this job's own sockets filled the port range or something else did.
export const summarizeNetstat = text => {
  const byState = {}, loopback = {}, owners = {}
  let total = 0
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'TCP' || parts.length < 5) continue
    const [, local, remote, state, pid] = parts
    total += 1
    byState[state] = (byState[state] ?? 0) + 1
    if (local.startsWith('127.0.0.1:') && remote.startsWith('127.0.0.1:')) {
      loopback[state] = (loopback[state] ?? 0) + 1
      owners[pid] = (owners[pid] ?? 0) + 1
    }
  }
  const topOwners = Object.entries(owners).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pid, sockets]) => ({ pid: Number(pid), sockets }))
  return { total, byState, loopback, topOwners }
}

// `netsh int ipv4 show dynamicport tcp`: the first port and how many there are.
export const parseDynamicPorts = text => {
  const start = Number(text.match(/Start Port\s*:\s*(\d+)/i)?.[1])
  const count = Number(text.match(/Number of Ports\s*:\s*(\d+)/i)?.[1])
  return Number.isInteger(start) && Number.isInteger(count) ? { start, count } : null
}

// Writes socket-state.json into a failed test's evidence when the failure is a socket limit on Windows. It only
// records; it never retries or hides the failure.
export const recordSocketState = (failure, evidence) => {
  if (process.platform !== 'win32' || !SOCKET_LIMIT.test(String(failure?.message ?? ''))) return null
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const run = (file, args) => spawnSync(join(system32, file), args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const netstat = run('netstat.exe', ['-ano', '-p', 'tcp'])
  const ports = run('netsh.exe', ['int', 'ipv4', 'show', 'dynamicport', 'tcp'])
  const record = {
    error: String(failure.message).match(SOCKET_LIMIT)[0],
    dynamicPorts: parseDynamicPorts(ports.stdout ?? ''),
    sockets: netstat.status === 0 ? summarizeNetstat(netstat.stdout) : null,
    errors: [netstat, ports].filter(one => one.error || one.status !== 0).map(one => one.error?.message ?? `status ${one.status}`),
  }
  writeFileSync(join(evidence, 'socket-state.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

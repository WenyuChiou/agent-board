import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { hookLoadMarker, leftoverProcesses, makeRedact, percentile, redactDeep, tallyOf } from './lib/soak-report.mjs'

process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// L6 hook load (#395): synthetic Codex, Grok and Antigravity sessions fire their real generated hooks
// against one isolated board while its page server runs. tests/e2e/soak.mjs starts it as a phase; it
// is not a *.test.mjs file, so it never runs per pull request. The full size (30 sessions for 10
// minutes) needs CI or AGENT_BOARD_HEAVY_TESTS=1; anywhere else it runs the smoke size, 3 sessions
// for 20 s, since the full one keeps a desktop busy.
//   node tests/e2e/hook-load.mjs [--out DIR] [--stop-on-stdin]
// --stop-on-stdin: a line "stop" on stdin, or stdin closing, stops the run as a signal does. soak.mjs
// passes it, so a soak that stops or dies never leaves this run going.

// A check that fails on main because of an open issue goes through knownFailure, but only while the
// failure fits that issue's pattern (hookLoadMarker); any other failure stays a failure. Every check
// here depends on load, so a lucky pass is allowed.
const TITLES = {
  leftovers: 'L6 hook load: no process the check started is alive 30 s after it ends',
  hooks: 'L6 hook load: each hook run ends within 3 s',
  caps: 'L6 hook load: progress.md, its companions and the inbox stay under the #373 caps',
  page: 'L6 hook load: the page shows each report within one poll',
  inbox: 'L6 hook load: the inbox is empty at the end, with no .taking or .tmp left',
}

const FULL = { sessions: 30, seconds: 600 }
const SMOKE = { sessions: 3, seconds: 20 }
const isFull = Boolean(process.env.CI) || process.env.AGENT_BOARD_HEAVY_TESTS === '1'
const MEGABYTE = 1048576
// The size caps of #373 (its part 5). The plugin store is Claude Code's and has no copy in the world.
const CAPS = { progressBytes: 512 * 1024, inboxFiles: 1000, inboxBytes: 1.5 * MEGABYTE, captures: 16, monthBytes: MEGABYTE }
// Each session starts within the first 20 s, then repeats a turn: the start event, 2 to 6 s of work,
// Stop, and 6 to 14 s before the next prompt. At the full size that is about 3 hook runs a second.
const START_SPREAD_MS = 20000
const WORK_MS = [2000, 6000]
const IDLE_MS = [6000, 14000]
const SEEN_GIVE_UP_MS = 20000
const OBSERVE_GAP_MS = 500
const SAMPLE_MS = 5000
const LEFTOVER_WAIT_MS = 30000
const START_EVENTS = { codex: 'UserPromptSubmit', grok: 'UserPromptSubmit', antigravity: 'PreInvocation' }
const PROJECTS = ['api-gateway', 'docs-site', 'research-hub', 'billing-core', 'mobile-app', 'infra-tools', 'data-pipeline', 'search-service']
const TOPICS = ['routes', 'cache', 'invoices', 'login', 'exports', 'search index', 'retries', 'metrics']
// Files the test itself puts beside progress.md, which are not the board's.
const SCAFFOLD = new Set(['agent-board.mjs', 'clipboard-preload.mjs', 'progress.md'])
const CAPTURE = /^progress-questions-source-[a-f0-9]{64}\.json$/
const MONTH_FILE = /-(?:journal|archive)-\d{4}-\d{2}\.md$/

const randomOf = seed => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const between = (random, [low, high]) => low + Math.floor(random() * (high - low))
const kilobytes = bytes => `${Math.round(bytes / 1024)} KB`
const firstLine = error => String(error?.message ?? error).split(/\r?\n/)[0]

// Every process running now, with its creation time where available, and the lister's own pid.
const processList = () => {
  if (process.platform === 'linux') {
    const list = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const close = stat.lastIndexOf(')')
        const fields = stat.slice(close + 2).split(' ')
        list.push({ pid: Number(entry), ppid: Number(fields[1]), started: Number(fields[19]), name: stat.slice(stat.indexOf('(') + 1, close), command: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ') })
      } catch {}
    }
    return { list }
  }
  const isWindows = process.platform === 'win32'
  const result = isWindows
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name="started";Expression={if ($null -ne $_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}} | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 64 * MEGABYTE })
    : spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,comm=,command='], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * MEGABYTE })
  if (result.status !== 0) throw new Error(`the process list could not be read (${result.error?.code ?? `exit ${result.status}`})`)
  const list = isWindows
    ? [JSON.parse(result.stdout)].flat().map(one => ({ pid: one.ProcessId, ppid: one.ParentProcessId, started: typeof one.started === 'number' ? one.started : undefined, name: one.Name ?? '', command: one.CommandLine ?? '' }))
    : result.stdout.split('\n').flatMap(line => {
      const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return found ? [{ pid: Number(found[1]), ppid: Number(found[2]), name: found[3], command: found[4] }] : []
    })
  return { list, lister: result.pid }
}

// The JSON report, through a temporary file and a rename; Windows refuses a rename onto a file another
// program has open, so that is retried briefly.
const writeJson = (dir, value) => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'hook-load.json')
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  for (let attempt = 1; ; attempt += 1) {
    try { renameSync(temporary, file); return } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

const hookLoad = async ({ out, isStdinStop }) => {
  const [{ makeWorld }, { HOOK_TIMEOUT_MS, PAGE_MS }, { hook, hookHosts }, { serve }, { knownFailure }] = await Promise.all([
    import('./lib/world.mjs'), import('./lib/budget.mjs'), import('./lib/writers.mjs'), import('./lib/surfaces.mjs'), import('./lib/known.mjs'),
  ])
  const size = isFull ? FULL : SMOKE
  const t0 = performance.now()
  const since = () => performance.now() - t0
  const report = { status: 'running', mode: isFull ? 'full' : 'smoke', sessions: size.sessions, seconds: size.seconds, startedAt: new Date().toISOString(), stats: undefined, checks: [], notes: [] }
  const redactions = [['<tmp>', tmpdir()], ['<home>', homedir()], ['<repo>', process.cwd()]]
  for (const [name, path] of [['<tmp>', tmpdir()], ['<home>', homedir()]]) {
    try { if (realpathSync.native(path) !== path) redactions.push([name, realpathSync.native(path)]) } catch {}
  }
  const secrets = []
  const redact = text => makeRedact(redactions, secrets)(text)
  const say = text => process.stdout.write(`${redact(text)}\n`)
  const problem = text => {
    if (report.notes.length < 12 && !report.notes.includes(text)) report.notes.push(text)
  }
  let saveFailure
  const save = () => {
    try {
      writeJson(out, redactDeep(report, redact))
      saveFailure = undefined
    } catch (error) { saveFailure = error }
  }

  // Stopping: a signal, stdin when asked, or the hard deadline. Every wait wakes at once, and the
  // run still closes its world and looks for leftover processes.
  const stopper = new AbortController()
  let isClosing = false
  const wakers = new Set()
  const sleep = ms => new Promise(done => {
    const wake = () => { clearTimeout(timer); wakers.delete(wake); done() }
    const timer = setTimeout(wake, ms)
    wakers.add(wake)
  })
  const stopNow = status => {
    if (stopper.signal.aborted) return
    report.status = status
    stopper.abort()
    for (const wake of [...wakers]) wake()
    // Teardown is already under way; a deadline only wakes waits, never starts it again.
    if (isClosing) return
    setTimeout(() => {
      problem('The run did not finish within 90 seconds of being stopped and was closed from outside.')
      save()
      process.exit(1)
    }, 90000).unref()
  }
  const isRunning = () => !stopper.signal.aborted
  process.on('SIGINT', () => stopNow('interrupted'))
  process.on('SIGTERM', () => stopNow('interrupted'))
  if (isStdinStop) {
    process.stdin.setEncoding('utf8').on('data', text => { if (/^stop$/m.test(text)) stopNow('interrupted') })
    process.stdin.on('end', () => stopNow('interrupted'))
  }
  const deadline = setTimeout(() => stopNow('timed out'), size.seconds * 1000 + 4 * 60000)

  save()
  if (saveFailure !== undefined) {
    clearTimeout(deadline)
    say(`hook load: the report cannot be written to ${out} (${saveFailure.code ?? saveFailure.message}).`)
    return 1
  }
  say(`hook load: the ${report.mode} run, ${size.sessions} sessions for ${size.seconds} s${isFull ? '' : ' (the full run needs CI or AGENT_BOARD_HEAVY_TESTS=1)'}`)

  let world, roots = []
  const runs = []
  const seen = []
  const answers = { count: 0, failed: 0, ms: [] }
  const peaks = { progressBytes: 0, inboxFiles: 0, inboxBytes: 0, captures: 0, monthBytes: 0, companionBytes: 0, queued: 0 }
  const outcomes = {}
  let hasSampleError = false
  try {
    world = makeWorld()
    roots = [world.root, realpathSync.native(world.root)]
    redactions.push(['<world>', world.root], ['<world>', realpathSync.native(world.root)])
    const pendingFolder = join(world.home, '.agent-board', 'pending')
    const queuedNow = () => { try { return readdirSync(pendingFolder).filter(name => name.endsWith('.json')).length } catch { return 0 } }
    const server = await serve.start(world, [], { lifetimeMs: size.seconds * 1000 + 6 * 60000, idleMinutes: Math.ceil(size.seconds / 60) + 10 })
    const token = new URL(server.url).searchParams.get('t')
    secrets.push(server.url, new URL(server.url).search, token)
    // The page's own poll interval, read from the page the server sends.
    await server.page()
    const pollMs = server.pollMs

    // The first hook of a host installs that host's hooks, so each host runs once alone first.
    for (const host of hookHosts) {
      const id = `load-${host}-warm-up`
      for (const event of [START_EVENTS[host], 'Stop']) {
        const result = await hook(world, host, event, { session_id: id, conversationId: id, sessionId: id, cwd: world.root, turn_id: 'warm-up', prompt: 'Warm up the hook', last_assistant_message: 'Warmed up.', lastAssistantMessage: 'Warmed up.' })
        assert.equal(result.status, 0, `the ${host} ${event} warm-up hook exited ${result.status}`)
      }
    }

    // The board's own files, as their largest size so far.
    const sampleProblem = error => {
      if (error.code === 'ENOENT') return
      if (!hasSampleError) problem(`A storage sample could not be read: ${firstLine(error)}`)
      hasSampleError = true
    }
    const sample = () => {
      const sizeOf = file => { try { return statSync(file).size } catch (error) { sampleProblem(error); return 0 } }
      const now = { progressBytes: sizeOf(world.path), inboxFiles: 0, inboxBytes: 0, captures: 0, monthBytes: 0, companionBytes: 0, queued: 0 }
      try {
        for (const entry of readdirSync(world.claudeDir, { withFileTypes: true })) {
          if (!entry.isFile() || SCAFFOLD.has(entry.name)) continue
          const bytes = sizeOf(join(world.claudeDir, entry.name))
          now.companionBytes += bytes
          if (CAPTURE.test(entry.name)) now.captures += 1
          if (MONTH_FILE.test(entry.name)) now.monthBytes = Math.max(now.monthBytes, bytes)
        }
      } catch (error) { sampleProblem(error) }
      try {
        for (const name of readdirSync(world.inbox)) {
          now.inboxFiles += 1
          now.inboxBytes += sizeOf(join(world.inbox, name))
        }
      } catch (error) { sampleProblem(error) }
      try { now.queued = readdirSync(pendingFolder).filter(name => name.endsWith('.json')).length } catch (error) { sampleProblem(error) }
      for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], now[key])
      return now
    }
    sample()
    const sampler = setInterval(sample, SAMPLE_MS)

    // The board's short id for a session, from its block marker (resume= is the session's own id).
    const shortIds = new Map()
    const shortIdOf = id => {
      if (!shortIds.has(id)) {
        let text = ''
        try { text = readFileSync(world.path, 'utf8') } catch {}
        const found = new RegExp(`^<!-- auto session=([a-f0-9]{8}) [^\\n]*? resume=${id}(?= |-->)`, 'm').exec(text)
        if (found) shortIds.set(id, found[1])
      }
      return shortIds.get(id)
    }
    // A 500 ms gap matches the soak and puts about a few open pages' load on the server. Each hook
    // that returned waits until an answer shows its session working (after the start event) or waiting (after Stop).
    const expected = new Set()
    const observerEnd = new AbortController()
    const board = new URL('/api/board', server.url)
    const observe = async () => {
      while (!observerEnd.signal.aborted) {
        if (expected.size === 0) { await sleep(OBSERVE_GAP_MS); continue }
        const start = since()
        let model
        try {
          const response = await fetch(board, { headers: { 'x-board-token': token }, signal: AbortSignal.any([AbortSignal.timeout(30000), observerEnd.signal]) })
          if (response.status === 200) model = (await response.json()).model
          else problem(`The page server answered a poll with ${response.status}.`)
        } catch (error) { if (!observerEnd.signal.aborted) problem(`A poll got no answer: ${firstLine(error)}`) }
        const at = since()
        answers.count += 1
        if (model === undefined) answers.failed += 1
        else {
          answers.ms.push(Math.round(at - start))
          const rows = [...model.groups.flatMap(group => group.rows), ...model.stopped, ...model.idle]
          for (const one of [...expected]) {
            const shortId = shortIdOf(one.id)
            const row = shortId === undefined ? undefined : rows.find(item => item.session === shortId)
            if (row !== undefined && / is working$/.test(row.status) === one.isWorking) one.done({ host: one.host, ms: Math.max(0, Math.round(at - one.returnedAt)) })
          }
        }
        await sleep(OBSERVE_GAP_MS)
      }
    }
    const shown = (id, host, isWorking, returnedAt) => new Promise(resolve => {
      if (!isRunning()) return resolve({ host, isCut: true })
      const one = { id, host, isWorking, returnedAt, done: result => { clearTimeout(timer); stopper.signal.removeEventListener('abort', cut); expected.delete(one); resolve(result) } }
      const timer = setTimeout(() => one.done({ host, isMissed: true }), SEEN_GIVE_UP_MS)
      const cut = () => one.done({ host, isCut: true })
      stopper.signal.addEventListener('abort', cut)
      expected.add(one)
    })

    const endAt = since() + size.seconds * 1000
    const session = async index => {
      const host = hookHosts[index % hookHosts.length]
      const id = `load-${host}-${index}`
      const cwd = join(world.root, PROJECTS[index % PROJECTS.length])
      const random = randomOf(index + 1)
      await sleep(START_SPREAD_MS * index / size.sessions)
      for (let turn = 1; isRunning() && since() < endAt; turn += 1) {
        const topic = TOPICS[(index + turn) % TOPICS.length]
        for (const [event, isWorking, gap] of [[START_EVENTS[host], true, WORK_MS], ['Stop', false, IDLE_MS]]) {
          if (!isRunning()) return
          const payload = { session_id: id, conversationId: id, sessionId: id, cwd, turn_id: `turn-${turn}`, prompt: `Check the ${topic}`, last_assistant_message: `Checked the ${topic}.`, lastAssistantMessage: `Checked the ${topic}.` }
          const start = performance.now()
          let isOk = false
          try {
            const result = await hook(world, host, event, payload)
            isOk = result.status === 0
            if (!isOk) problem(`A ${host} ${event} hook exited ${result.status}: ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0]}`)
          } catch (error) { problem(`A ${host} ${event} hook failed: ${firstLine(error)}`) }
          runs.push({ host, event, ms: Math.round(performance.now() - start), isOk })
          // Whether any hook event sat in the queue when this one returned: a queued event reaches
          // the page only when a later hook applies it.
          if (isOk) { const isQueued = queuedNow() > 0; seen.push({ ...await shown(id, host, isWorking, since()), isQueued }) }
          if (since() < endAt) await sleep(between(random, gap))
        }
      }
    }

    const observing = observe().catch(error => problem(`The page observer stopped on an error: ${firstLine(error)}`))
    try {
      await Promise.all(Array.from({ length: size.sessions }, (_, index) => session(index)))
    } finally {
      observerEnd.abort()
      for (const wake of [...wakers]) wake()
      await observing
      clearInterval(sampler)
    }
    sample()

    // The end state, before the world closes: what is still queued, and any temporary file left.
    const queuedLeft = queuedNow()
    const inboxLeft = (() => { try { return readdirSync(world.inbox).length } catch { return 0 } })()
    let temporaries = 0
    try { temporaries = readdirSync(world.home, { recursive: true }).map(String).filter(name => /\.(?:taking|tmp)$/.test(name)).length } catch (error) { problem(`The home folder could not be listed: ${firstLine(error)}`) }
    outcomes.inbox = { ok: queuedLeft === 0 && inboxLeft === 0 && temporaries === 0, line: `At the end, ${inboxLeft} files in progress-inbox, ${queuedLeft} queued hook events and ${temporaries} .taking or .tmp files.` }
    // What the hooks wrote to their own error log, by code.
    const codes = {}
    try {
      for (const line of readFileSync(join(world.home, '.agent-board', 'hook-errors.log'), 'utf8').split('\n')) {
        const [, agent, code] = line.split(' ')
        if (code) codes[`${agent} ${code}`] = (codes[`${agent} ${code}`] ?? 0) + 1
      }
    } catch {}

    const times = runs.map(one => one.ms)
    const byHost = Object.fromEntries(hookHosts.map(host => {
      const own = runs.filter(one => one.host === host).map(one => one.ms)
      return [host, { runs: own.length, p50: percentile(own, 0.5), p95: percentile(own, 0.95), max: own.length ? Math.max(...own) : undefined }]
    }))
    const over = runs.filter(one => one.ms > HOOK_TIMEOUT_MS)
    const failedRuns = runs.filter(one => !one.isOk)
    const overBy = hookHosts.map(host => `${host} ${over.filter(one => one.host === host).length}`).join(', ')
    outcomes.hooks = {
      ok: runs.length > 0 && over.length === 0 && failedRuns.length === 0,
      over: over.length,
      failedRuns: failedRuns.length,
      maxMs: times.length ? Math.max(...times) : 0,
      line: `${runs.length} hook runs: p50 ${percentile(times, 0.5) ?? '?'} ms, p95 ${percentile(times, 0.95) ?? '?'} ms, max ${times.length ? Math.max(...times) : '?'} ms; over ${HOOK_TIMEOUT_MS} ms: ${over.length} (${overBy}); ${failedRuns.length} did not exit 0.`,
    }
    const shownMs = seen.filter(one => one.ms !== undefined).map(one => one.ms)
    const late = shownMs.filter(ms => ms > PAGE_MS).length
    const missed = seen.filter(one => one.isMissed).length
    const slow = seen.filter(one => one.isMissed || one.ms > PAGE_MS)
    const slowNotQueued = slow.filter(one => !one.isQueued).length
    const slowBy = hookHosts.map(host => `${host} ${slow.filter(one => one.host === host).length}`).join(', ')
    outcomes.page = {
      ok: shownMs.length > 0 && late === 0 && missed === 0,
      shown: shownMs.length,
      slow: slow.length,
      slowNotQueued,
      failedAnswers: answers.failed,
      line: `${seen.length} reports: shown after p50 ${percentile(shownMs, 0.5) ?? '?'} ms, p95 ${percentile(shownMs, 0.95) ?? '?'} ms, max ${shownMs.length ? Math.max(...shownMs) : '?'} ms; ${late} later than ${PAGE_MS} ms (the page polls every ${pollMs} ms), ${missed} not shown within ${SEEN_GIVE_UP_MS / 1000} s.${slow.length ? ` Of the late and missed ${slow.length} (${slowBy}), ${slow.length - slowNotQueued} came back while hook events were queued.` : ''}`,
    }
    const isUnderCaps = !hasSampleError && peaks.progressBytes > 0 && peaks.progressBytes <= CAPS.progressBytes && peaks.inboxFiles <= CAPS.inboxFiles && peaks.inboxBytes <= CAPS.inboxBytes && peaks.captures <= CAPS.captures && peaks.monthBytes <= CAPS.monthBytes
    outcomes.caps = {
      ok: isUnderCaps,
      line: `At most: progress.md ${kilobytes(peaks.progressBytes)} (cap 512 KB), progress-inbox ${peaks.inboxFiles} files and ${kilobytes(peaks.inboxBytes)} (caps 1,000 files and 1.5 MB), ${peaks.captures} question capture files (cap 16), the largest month file ${kilobytes(peaks.monthBytes)} (cap 1 MB); all the board's other files beside progress.md ${kilobytes(peaks.companionBytes)}, ${peaks.queued} queued hook events.${peaks.progressBytes === 0 ? ' No progress.md data was measured.' : ''}${hasSampleError ? ' A storage sample could not be read.' : ''}`,
    }
    report.stats = { runs: runs.length, turns: Math.floor(runs.length / 2), hooks: { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: times.length ? Math.max(...times) : undefined, byHost }, page: { reports: seen.length, p50: percentile(shownMs, 0.5), p95: percentile(shownMs, 0.95), max: shownMs.length ? Math.max(...shownMs) : undefined, late, missed, slow: slow.length, slowNotQueued, pollMs }, answers: { count: answers.count, failed: answers.failed, p50: percentile(answers.ms, 0.5), p95: percentile(answers.ms, 0.95), max: answers.ms.length ? Math.max(...answers.ms) : undefined }, peaks, hookErrors: codes }
  } catch (error) {
    report.status = 'failed'
    problem(`The run stopped on an error: ${firstLine(error)}`)
  }

  // Leftover processes: the world closes (its page server too), then nothing from this run's own
  // tree may be left after 30 s, or 10 s when stopped: no descendant of this process, and nothing
  // whose command line names the world's folder, which also finds a worker whose parent is gone.
  const closedAt = new Date().toISOString()
  isClosing = true
  try { await world?.close() } catch (error) { problem(`The world did not close cleanly: ${firstLine(error?.errors?.[0] ?? error)}`) }
  if (world !== undefined) {
    const leftoverWaitMs = stopper.signal.aborted || report.status === 'failed' ? 10000 : LEFTOVER_WAIT_MS
    const waitNote = leftoverWaitMs < LEFTOVER_WAIT_MS ? ' The wait was shortened because the run was stopped.' : ''
    await new Promise(done => setTimeout(done, leftoverWaitMs))
    try {
      const { list, lister } = processList()
      if (!list.some(one => one.pid === process.pid)) throw new Error('the process list did not include this run')
      const left = leftoverProcesses({ list, self: process.pid, roots, exclude: lister === undefined ? [] : [lister] })
      for (const one of left) { try { process.kill(one.pid, 'SIGKILL') } catch {} }
      let stopping = ''
      if (left.length > 0) {
        const after = processList().list
        if (!after.some(one => one.pid === process.pid)) throw new Error('the process list did not include this run')
        const remaining = left.filter(one => after.some(next => next.pid === one.pid && (one.started === undefined || next.started === undefined || next.started === one.started))).length
        stopping = remaining === 0 ? 'They were stopped.' : `${remaining} could not be stopped.`
      }
      const names = Object.entries(left.reduce((counts, one) => ({ ...counts, [one.name]: (counts[one.name] ?? 0) + 1 }), {})).map(([name, count]) => `${name} ${count}`).join(', ')
      outcomes.leftovers = { ok: left.length === 0, line: (left.length === 0 ? `None of ${list.length} processes running ${leftoverWaitMs / 1000} s after the end (${closedAt.slice(11, 19)}) came from this check.` : `${left.length} processes from this check were still running ${leftoverWaitMs / 1000} s after the end: ${names}. ${stopping}`) + waitNote }
    } catch (error) { outcomes.leftovers = { ok: false, line: `The processes could not be counted: ${firstLine(error)}` } }
  }

  for (const [key, title] of Object.entries(TITLES)) {
    const outcome = outcomes[key]
    if (outcome === undefined) { report.checks.push({ title, status: 'fail', line: 'Not measured: the run ended before this check.' }); continue }
    const marker = hookLoadMarker({ key, outcome, platform: process.platform, budgetMs: HOOK_TIMEOUT_MS })
    if (marker === undefined || (!outcome.ok && !marker.explains)) {
      report.checks.push({ title, status: outcome.ok ? 'pass' : 'fail', line: `${outcome.line}${marker ? ` Not the pattern of #${marker.issue}.` : ''}` })
      continue
    }
    const { issue } = marker
    try {
      await knownFailure(issue, () => { if (!outcome.ok) assert.fail(outcome.line) }, { mayPass: true })
      report.checks.push(outcome.ok ? { title, status: 'pass', line: outcome.line } : { title, status: 'known', line: `${outcome.line} Known problem (#${issue}).` })
    } catch (error) { report.checks.push({ title, status: 'fail', line: `${firstLine(error)} ${outcome.line}` }) }
  }
  if (report.status === 'running') report.status = 'finished'
  report.finishedAt = new Date().toISOString()
  save()
  for (const check of report.checks) say(`${check.status}: ${check.title} - ${check.line}`)
  for (const note of report.notes) say(`note: ${note}`)
  say(`hook load: ${tallyOf(report.checks)}; ${report.status}`)
  if (saveFailure !== undefined) say(`hook load: the report could not be written (${saveFailure.code ?? saveFailure.message}).`)
  clearTimeout(deadline)
  return report.status === 'finished' && saveFailure === undefined && report.checks.every(check => check.status === 'pass' || check.status === 'known') ? 0 : 1
}

const argv = process.argv.slice(2)
const outAt = argv.indexOf('--out')
const isStdinStop = argv.includes('--stop-on-stdin')
const out = outAt === -1 ? join(tmpdir(), `agent-board-hook-load-${process.pid}`) : argv[outAt + 1]
const known = new Set(['--out', '--stop-on-stdin'])
if (argv.some((flag, at) => !known.has(flag) && argv[at - 1] !== '--out') || (outAt !== -1 && (out === undefined || out.startsWith('--'))) || argv.filter(flag => flag === '--out').length > 1) {
  process.stderr.write('The hook load check takes only --out DIR and --stop-on-stdin.\n')
  process.exitCode = 2
} else {
  const code = await hookLoad({ out, isStdinStop })
  if (outAt === -1) process.stdout.write(`hook load: the report is in ${out}\n`)
  process.stdout.write('', () => process.exit(code))
}

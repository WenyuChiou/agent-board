import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { arch, homedir, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { archiveIntegrity, archiveProblems, liveMemoryLevel, makeRedact, median, percentile, tallyOf, writeReport } from './lib/soak-report.mjs'
import { classifyMessageStoreFiles, isMessageStoreClean, messageStoreFileState, readMessageStoreFiles } from './lib/message-store-files.mjs'

// L6 messaging soak: the message hub (--serve) at the scale the owner set for M1: 200 registered
// sessions (never more than 100 live, half of them ended), 5,000 messages (acknowledged, rejected,
// uncertain, dismissed, contested), a hub killed mid-delivery, and a clock that jumps past the
// retention. It is not a *.test.mjs file, so it never runs per pull request; soak.mjs runs it after
// the board soak, and it runs alone:
//   node tests/e2e/soak-messaging.mjs [--minutes 1..15] [--out DIR]

const MINUTES_LEAST = 1
const MINUTES_MOST = 15
const MINUTES_DEFAULT = 8
// A run this long is meant to measure everything: a check it could not measure fails it. A shorter
// run, tried by hand, may skip.
const FULL_MINUTES = 8
const REPORT_JSON = 'messaging-report.json'
const REPORT_MD = 'messaging-report.md'

const TITLES = {
  traffic: 'L6 messaging soak: the whole scenario ran (200 sessions, 5,000 messages, every outcome and every refusal) and every request got an answer',
  memory: 'L6 messaging soak: the memory the hub holds levels off once the message store is full',
  store: 'L6 messaging soak: the message file levels off and never holds more than 1,000 finished messages',
  privacy: 'L6 messaging soak: no finished message keeps its text, no reply shows its nonce and the message folder holds only its own files',
  registrations: 'L6 messaging soak: ended registrations leave the hub and it never holds more than 100 live connections',
  retire: 'L6 messaging soak: finished messages are gone after a 25-hour clock jump',
  archive: 'L6 messaging soak: ended sessions\' progress blocks are archived on the board\'s schedule for stopped blocks',
  ops: 'L6 messaging soak: a page poll and an idle receiver poll cost no more file operations at 200 sessions and a full store than at 10 sessions',
  hooks: 'L6 messaging soak: the prompt hooks finish inside their host time limit with a full message store',
  crash: 'L6 messaging soak: a hub killed at scale starts again, its claimed messages come back uncertain and none is handed out twice',
  notes: 'L6 messaging soak: the soak itself recorded no error, no failed step and no unexpected answer',
}

const MEGABYTE = 1048576
const ENDING = 100
const BASELINE = 10
const DUPLICATES = 10
const MESSAGES = 5000
const SETTLE_SENT = 2000
const MAX_RATE = 30
const LEASE_MS = 15000
const WINDOW_MS = 20000
const SAMPLE_MS = 10000
const SAMPLE_EVERY = 250
const OPEN_MOST = 2
const FINISHED_CAP = 1000
const HELD = 30
const JUMP = '25h'

const AGENTS = ['codex', 'antigravity', 'hermes', 'grok', 'gemini', 'cursor', 'opencode', 'muse']
const PROJECTS = ['api-gateway', 'docs-site', 'research-hub', 'billing-core', 'mobile-app', 'infra-tools', 'data-pipeline', 'search-service']
const TOPICS = ['routes', 'cache', 'invoices', 'login', 'exports', 'search index', 'retries', 'metrics', 'templates', 'queue', 'backups', 'rate limits']
const HOOKS = [['codex', 'SessionStart'], ['codex', 'UserPromptSubmit'], ['grok', 'SessionStart'], ['grok', 'UserPromptSubmit'], ['antigravity', 'SessionStart'], ['antigravity', 'PreInvocation']]
const REFUSALS = new Set(['TARGET_BUSY', 'PAIR_BUSY', 'CONTESTED'])
// The hub holds at most this many open messages for one target (TARGET_OPEN_CAP in hooks/messaging.ts);
// the one after them is refused TARGET_BUSY.
const TARGET_CAP = 3
// The scenario's size: a run that falls short of it has not tested what it says.
const SENT_SHARE = 0.95
// The soak sends only where its own count says there is room, and that count trails the hub's, so a
// few sends are refused busy anyway. More than this share means the hub refuses sends it has room for.
const UNASKED_SHARE = 0.01
// External memory swings by several MB between memory lines (soak runs of 2026-10-22), which blurs a
// slope over 3,000 messages by about 1.3 KB per message; only a leak past this shows through it.
const EXTERNAL_LIMIT = 4096
// What the plan for a message says its receiver does: 70 / 10 / 10 / 5 of the 95 drawn.
const OUTCOMES = [['ack', 70], ['reject', 10], ['uncertain', 10], ['dismiss', 5]]

// The same numbers every run, so two runs can be set side by side.
const random = (() => {
  let seed = 0x9e3779b9
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
})()
const between = (least, most) => least + random() * (most - least)

const shown = value => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 40)
// --minutes (a whole number from 1 to 15) and --out (a folder), each once; a bad command line comes
// back as one plain sentence, never a stack trace.
const parseArguments = argv => {
  const given = new Set()
  let minutes = MINUTES_DEFAULT
  let out = join(tmpdir(), `agent-board-messaging-soak-${process.pid}`)
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at]
    if (flag !== '--minutes' && flag !== '--out') return { error: `Unknown argument "${shown(flag)}": the messaging soak takes only --minutes and --out.` }
    if (given.has(flag)) return { error: `${flag} was given more than once.` }
    given.add(flag)
    const value = argv[at + 1]
    if (flag === '--minutes') {
      if (value === undefined || !/^[1-9]\d*$/.test(value) || Number(value) > MINUTES_MOST) return { error: `--minutes needs a whole number from ${MINUTES_LEAST} to ${MINUTES_MOST}${value === undefined ? '' : `, not "${shown(value)}"`}.` }
      minutes = Number(value)
    } else {
      if (value === undefined || value === '' || value.startsWith('--')) return { error: '--out needs a folder name.' }
      out = value
    }
  }
  return { minutes, out }
}

const kilobytes = bytes => (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)
const megabytes = bytes => (bytes / MEGABYTE).toFixed(0)
const count = value => (value === undefined ? '?' : Number(value).toLocaleString('en-US'))

// Plain words, one table, from whatever the report holds.
const reportMarkdown = report => {
  const lines = ['# Messaging soak report', '']
  lines.push(`Status: ${report.status}. The messaging soak was set for ${report.minutes} minutes on ${report.os} with Node ${report.node}.`, '')
  lines.push('| Check | Result | What was measured |', '| --- | --- | --- |')
  for (const check of report.checks ?? []) lines.push(`| ${check.title} | ${check.status} | ${String(check.line).replace(/\|/g, '/')} |`)
  if ((report.checks ?? []).length > 0) lines.push('', `Checks: ${tallyOf(report.checks)}.`)
  lines.push('', '## Numbers', '')
  const traffic = report.traffic
  if (traffic) {
    lines.push(`- Messages: ${count(traffic.sent)} sent and accepted, by plan ${Object.entries(traffic.byOutcome ?? {}).map(([name, many]) => `${name} ${count(many)}`).join(', ')}; refused as the soak asked for ${Object.entries(traffic.refused ?? {}).map(([name, many]) => `${name} ${count(many)}`).join(', ') || 'none'}.`)
    if (traffic.receipts) lines.push(`- Receipts the hub accepted, by status: ${Object.entries(traffic.receipts).map(([name, many]) => `${name} ${count(many)}`).join(', ')}.`)
    const unasked = Object.entries(traffic.unasked ?? {}).filter(([, many]) => many > 0)
    if (unasked.length > 0) lines.push(`- Refused although the soak had not asked for it: ${unasked.map(([name, many]) => `${name} ${count(many)}`).join(', ')}.`)
    lines.push(`- Sessions: ${count(traffic.registered)} registered, ${count(traffic.ended)} ended (${count(traffic.endedByDisconnect)} by disconnect, ${count(traffic.endedByExpiry)} by letting the lease run out), ${count(traffic.duplicates)} registered twice and so contested (${count(traffic.duplicatesSkipped ?? 0)} more were not, as they still held a message after 30 s), most live at once ${count(traffic.mostLive)}.`)
    lines.push(`- Requests: ${count(traffic.requests)}; ${count(traffic.failures)} failed unexpectedly; ${count(traffic.resent)} sent again after a kept-alive connection closed first.`)
    for (const [name, one] of Object.entries(traffic.latency ?? {})) lines.push(`- ${name}: a typical one took ${one.median} ms, one in 20 took longer than ${one.p95} ms, the slowest took ${one.max} ms (${count(one.count)} requests).`)
  }
  for (const phase of report.phases ?? []) lines.push(`- ${phase.name} began after ${phase.seconds} s.`)
  const ops = report.ops
  if (ops) for (const [name, one] of Object.entries(ops)) lines.push(`- File operations at ${name}: ${one.idle === undefined ? 'not measured' : `${one.idle.toFixed(2)} per idle receiver poll, ${one.page.toFixed(1)} per page poll`}.`)
  const memory = report.memory ?? []
  if (memory.length > 0) lines.push(`- Hub memory: ${megabytes(memory[0].bytes)} MB at the start, ${megabytes(Math.max(...memory.map(one => one.bytes)))} MB at the highest.`)
  if (report.store) lines.push(`- Message file: ${kilobytes(report.store.bytesAtSettle ?? 0)} KB once ${count(report.store.settleSent)} messages were sent, ${kilobytes(report.store.bytesMost ?? 0)} KB at the largest; most open ${count(report.store.openMost)}, most finished ${count(report.store.finishedMost)}.`)
  if (report.hooks?.length > 0) lines.push(`- Hooks: ${report.hooks.map(one => `${one.host} ${one.event} ${one.msMost} ms of ${one.limit}`).join('; ')}.`)
  if (report.crash) lines.push(`- Crash at scale: ${report.crash.line}`)
  for (const note of report.notes ?? []) lines.push(`- Note: ${note}`)
  lines.push('')
  return lines.join('\n')
}

// Both files, each through a temporary file and a rename (the board soak's writer), under this soak's own names.
const writeMessagingReport = (dir, report, redact) => writeReport(dir, report, redact, { json: REPORT_JSON, markdown: REPORT_MD, words: reportMarkdown })

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const soak = async ({ minutes, out }) => {
  const [{ makeWorld }, { LIVE_SESSIONS }, { block, hook }, { serve, run }, { knownFailure }, { hookTimeout }, { killServe, isFinishedRecord }] = await Promise.all([
    import('./lib/world.mjs'), import('./lib/budget.mjs'), import('./lib/writers.mjs'), import('./lib/surfaces.mjs'), import('./lib/known.mjs'),
    import('../../hooks/hook-safety.ts'), import('./lib/hub-wire.mjs'),
  ])
  const total = minutes * 60000
  const t0 = performance.now()
  const since = () => performance.now() - t0
  const isFullRun = minutes >= FULL_MINUTES

  const report = {
    status: 'running', os: `${process.platform} ${release()} ${arch()}`, node: process.version, minutes,
    startedAt: new Date().toISOString(), phases: [], traffic: undefined, ops: {}, memory: [], store: undefined, series: [], hooks: [], crash: undefined, retire: undefined, checks: [], notes: [],
  }
  const redactions = [['<tmp>', tmpdir()], ['<home>', homedir()], ['<repo>', process.cwd()]]
  for (const [name, path] of [['<tmp>', tmpdir()], ['<home>', homedir()]]) {
    try { if (realpathSync.native(path) !== path) redactions.push([name, realpathSync.native(path)]) } catch {}
  }
  const secrets = []
  let saveFailure
  const save = () => {
    try {
      writeMessagingReport(out, report, makeRedact(redactions, secrets))
      saveFailure = undefined
    } catch (error) { saveFailure = error }
  }
  const say = text => process.stdout.write(`${makeRedact(redactions, secrets)(text)}\n`)
  // Every call is counted, though the notes keep only the first twelve different ones; the last check fails on any.
  let problemCount = 0
  const problem = text => {
    problemCount += 1
    if (report.notes.length < 12 && !report.notes.includes(text)) report.notes.push(text)
  }

  // Stopping: a signal, or the hard deadline of minutes + 3. Every wait wakes at once.
  const control = { stop: undefined }
  const stopper = new AbortController()
  const wakers = new Set()
  const sleep = ms => new Promise(done => {
    const wake = () => { clearTimeout(timer); wakers.delete(wake); done() }
    const timer = setTimeout(wake, ms)
    wakers.add(wake)
  })
  const isRunning = () => control.stop === undefined
  // Waits for the condition, or for the limit; true when the condition held.
  const until = async (isDone, limitMs, stepMs = 50) => {
    const end = Date.now() + limitMs
    while (isRunning() && !isDone() && Date.now() < end) await sleep(stepMs)
    return isDone()
  }
  let world, server
  // The hub is a detached process: it is ended only while the world's address file still names its pid.
  const endHub = () => { try { if (server?.isOwned()) process.kill(server.pid) } catch {} }
  let isGivingUp = false
  const giveUp = async note => {
    if (isGivingUp) return
    isGivingUp = true
    problem(note)
    save()
    endHub()
    await Promise.race([world?.close().catch(() => {}), new Promise(done => setTimeout(done, 15000))])
    process.exit(1)
  }
  const stopNow = status => {
    if (control.stop !== undefined) return
    control.stop = status
    report.status = status
    save()
    stopper.abort()
    for (const wake of [...wakers]) wake()
    setTimeout(() => giveUp('The messaging soak did not stop in 30 seconds and was closed from outside.'), 30000).unref()
  }
  process.on('SIGINT', () => stopNow('interrupted'))
  process.on('SIGTERM', () => stopNow('interrupted'))
  const crashed = error => {
    report.status = 'failed'
    giveUp(`The messaging soak stopped on an error nothing caught: ${String(error?.message ?? error).split('\n')[0]}`)
  }
  process.on('uncaughtException', crashed)
  process.on('unhandledRejection', crashed)
  process.on('exit', endHub)
  const deadline = setTimeout(() => stopNow('timed out'), total + 3 * 60000)

  let phase = 'start'
  const setPhase = name => {
    phase = name
    report.phases.push({ name, seconds: Math.round(since() / 1000) })
    say(`messaging soak: ${name} began after ${Math.round(since() / 1000)} s`)
    save()
  }

  save()
  // A folder the report cannot be written to is found now, not after the whole run.
  if (saveFailure !== undefined) {
    clearTimeout(deadline)
    say(`messaging soak: the report cannot be written to ${out} (${saveFailure.code ?? saveFailure.message}).`)
    return 1
  }

  // What the run counts.
  const failures = { count: 0, byKind: {}, races: 0 }
  // The refusals the scenario provokes on purpose, counted when the one asked for came back; and the
  // same codes on a send nothing had asked to refuse, which are tolerated up to UNASKED_SHARE of the sends.
  const refused = { TARGET_BUSY: 0, PAIR_BUSY: 0, CONTESTED: 0 }
  const unasked = { TARGET_BUSY: 0, PAIR_BUSY: 0, CONTESTED: 0 }
  // The receipts the hub accepted, by the status they carried: the plan's outcomes as the hub saw them.
  const receipts = { acknowledged: 0, rejected: 0, uncertain: 0 }
  // How many messages had been sent by each moment, so a probe line can be set against it.
  const sentLog = []
  const byOutcome = { ack: 0, reject: 0, uncertain: 0, dismiss: 0, drop: 0, hold: 0 }
  const latency = { 'page poll': [], 'receiver poll': [], send: [], receipt: [] }
  const tally = { requests: 0, resent: 0, sent: 0, registered: 0, ended: 0, endedByDisconnect: 0, endedByExpiry: 0, duplicates: 0, duplicatesSkipped: 0, mostLive: 0, mostConnections: 0, claimed: 0, answered: 0 }
  const leaks = { file: 0, api: 0, replies: 0, example: undefined }
  const invariants = { ghosts: 0, missing: 0, example: undefined }
  let messageFiles = messageStoreFileState()
  const ownedServePids = new Set()
  const series = report.series
  let serveArgs, serveOptions
  let probeRows = []
  // Later steps (a dismissal, a duplicate going away, a session ending) wait on timers; they are all cleared at the end.
  const timers = new Set()
  let lastBoard
  let growthEndedAt
  let settle = { sent: undefined, bytes: undefined, at: undefined }
  const store = { bytesMost: 0, openMost: 0, finishedMost: 0, unreadable: 0, contentReads: 0, finishedRead: 0 }

  try {
    world = makeWorld()
    redactions.push(['<world>', world.root], ['<world>', realpathSync.native(world.root)])
    const probeDir = join(world.root, 'probe')
    const messagesDir = join(world.root, 'messages')
    mkdirSync(probeDir)
    mkdirSync(messagesDir)
    world.env.E2E_SOAK_PROBE_DIR = probeDir
    world.env.E2E_SOAK_PROBE_GC = '1'
    world.env.NODE_OPTIONS += ` --import=${pathToFileURL(fileURLToPath(new URL('./lib/soak-probe.mjs', import.meta.url))).href}`
    // Writers go through a rename, as a host's reporter does, so a board read never meets half a file.
    const sw = Object.create(world, {
      write: {
        value: (name, text) => {
          const temporary = world.write(`${name}.soak-tmp`, text)
          const file = join(world.claudeDir, name)
          for (let attempt = 1; ; attempt += 1) {
            try { renameSync(temporary, file); return file } catch (error) {
              if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
              wait(25)
            }
          }
        },
      },
    })

    serveArgs = ['--messages-dir', messagesDir]
    // The page server's own idle exit counts in the world's clock, which jumps 25 hours at a time
    // near the end; it must outlast one jump (the soak asks the board between jumps).
    serveOptions = { lifetimeMs: total + 6 * 60000, idleMinutes: 2000 }
    server = await serve.start(world, serveArgs, serveOptions)
    ownedServePids.add(server.pid)
    const token = () => new URL(server.url).searchParams.get('t')
    secrets.push(server.url, new URL(server.url).search, token())
    const firstPid = server.pid

    // Why a request got no answer, in plain words for the report.
    const causeOf = error => {
      const code = error?.cause?.code ?? error?.code
      if (error?.name === 'TimeoutError' || ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout'
      if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'].includes(code)) return 'closed'
      if (code === 'ECONNREFUSED') return 'refused'
      return 'other'
    }
    // One request to the hub. A kept-alive connection that closes before any answer is the race a
    // browser sends the request again for; the hub never had it, so it is sent once more, and counted.
    // Sending the same id again is safe: the hub answers an exact retry with the same receipt.
    const call = async (method, path, body, timeoutMs = 30000) => {
      tally.requests += 1
      for (let attempt = 1; ; attempt += 1) {
        let response
        try {
          response = await fetch(new URL(path, server.url), {
            method, headers: body === undefined ? { 'x-board-token': token() } : { 'x-board-token': token(), 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopper.signal]),
          })
        } catch (error) {
          const cause = causeOf(error)
          if (cause === 'closed' && attempt === 1 && isRunning()) { tally.resent += 1; continue }
          return { status: 0, cause, json: {} }
        }
        let json = {}
        try { json = JSON.parse(await response.text()) } catch {}
        return { status: response.status, json }
      }
    }
    const hub = (action, body) => call('POST', `/api/messages/${action}`, body)
    const timed = async (kind, work) => {
      const start = performance.now()
      const answer = await work()
      latency[kind].push(Math.round(performance.now() - start))
      return answer
    }
    // Anything but the refusals the scenario provokes on purpose is a failure.
    const unexpected = (what, answer, session) => {
      if (!isRunning()) return
      const cause = answer.json?.error ?? answer.cause ?? `status ${answer.status}`
      // A call that raced the end of a session the soak itself was ending is counted apart.
      if (session !== undefined && ['ending', 'ended'].includes(session.state) && ['CONNECTOR_NOT_CONNECTED', 'MESSAGE_FINISHED', 'OFFLINE'].includes(cause)) { failures.races += 1; return }
      failures.count += 1
      const key = `${what}: ${cause}`
      failures.byKind[key] = (failures.byKind[key] ?? 0) + 1
      problem(`Unexpected answer to ${key}`)
    }

    // The probe: what the hub did, by pid, in epoch time.
    const readProbe = () => {
      let names = []
      try { names = readdirSync(probeDir) } catch { return }
      const next = []
      for (const name of names) {
        const match = /^serve-([1-9][0-9]*)\.jsonl$/.exec(name)
        if (!match || Number(match[1]) > 2147483647) continue
        let text = ''
        try { text = readFileSync(join(probeDir, name), 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          if (line === '') continue
          try {
            const row = JSON.parse(line)
            if (row.role !== 'serve' || row.pid !== Number(match[1])) continue
            ownedServePids.add(row.pid)
            next.push({ at: row.at, pid: row.pid, rss: row.rss, heap: row.heapUsed, heapAfterGc: row.heapAfterGc, external: row.external, arrayBuffers: row.arrayBuffers, ops: Object.values(row.ops).reduce((sum, value) => sum + value, 0), requests: row.requests })
          } catch {}
        }
      }
      probeRows = next.sort((a, b) => a.at - b.at)
    }
    const linesOf = pid => probeRows.filter(row => row.pid === pid)
    const lineAfter = async (limit, isAfter) => {
      await until(() => { readProbe(); return linesOf(server.pid).some(isAfter) }, limit, 250)
      return linesOf(server.pid).find(isAfter)
    }

    // The message file, as the hub saved it. Another process replaces it by rename, so a read that
    // meets the replacement is tried again.
    const readFileStore = () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const file = join(messagesDir, 'messages.json')
          const text = readFileSync(file, 'utf8')
          const records = JSON.parse(text).messages
          return { bytes: Buffer.byteLength(text), records }
        } catch (error) {
          if (error.code === 'ENOENT') return { bytes: 0, records: [] }
          wait(20)
        }
      }
      store.unreadable += 1
      return undefined
    }
    // A read that came back: the finished messages in it must hold no text. The privacy check needs
    // at least one such read with finished messages in it, since a file that could not be read, or
    // held none, shows nothing about what finished messages keep.
    const scanRecords = records => {
      const finished = records.filter(isFinishedRecord)
      store.contentReads += 1
      store.finishedRead += finished.length
      leaks.file = Math.max(leaks.file, finished.filter(one => one.text !== '').length)
    }

    // The data: a block for every session in progress.md, written the way soak.mjs writes blocks.
    const sessions = []
    const makeSession = number => {
      const session = {
        number, agent: AGENTS[number % AGENTS.length], id: `${String(number + 1).padStart(8, '0')}-2222-4333-8444-555555555555`, blockId: (0xc3000000 + number).toString(16),
        turn: `turn-${number + 1}`, project: PROJECTS[number % PROJECTS.length], title: `Messaging soak task ${number + 1}: ${TOPICS[number % TOPICS.length]}`,
        state: 'new', conn: undefined, contested: false, stuck: false, open: new Set(), openFrom: new Map(), busy: 0, lastHops: 0,
        registeredAt: 0, leaseFloor: 0, lastPollEnd: 0, endedAt: 0, endBeginAt: 0, endKind: undefined, receiver: undefined, dropOnClaim: false, hasDropped: false,
      }
      sessions[number] = session
      return session
    }
    const writeBlock = (session, state) => {
      try {
        block(sw, {
          project: session.project, agent: session.agent, session: session.blockId, state, title: session.title,
          steps: [state === 'working' ? '- [~] Answer the synthetic message' : '- [ ] Answer the synthetic message'],
        })
      } catch (error) { problem(`A writer failed: ${String(error.message).split('\n')[0]}`) }
    }
    const liveSessions = () => sessions.filter(one => one?.state === 'live')
    // How many connections the hub should hold now: live and ending ones, duplicates, and ended
    // ones whose lease has not yet run out.
    const duplicates = new Set()
    const connectionsHeld = () => sessions.filter(one => one !== undefined && one.conn !== undefined && (one.endKind !== 'expiry' ? one.state !== 'ended' : Date.now() < one.lastPollEnd + LEASE_MS + 2000)).length + [...duplicates].filter(one => one.state !== 'ended').length

    // The plans: what a message's receiver does with it, drawn when it is sent.
    const plans = new Map()
    const draw = () => {
      let point = random() * OUTCOMES.reduce((sum, one) => sum + one[1], 0)
      for (const [name, weight] of OUTCOMES) { point -= weight; if (point < 0) return name }
      return 'ack'
    }
    const later = (ms, work) => {
      const timer = setTimeout(() => { timers.delete(timer); work().catch(error => problem(`A later step failed: ${String(error?.message ?? error).split('\n')[0]}`)) }, ms)
      timers.add(timer)
    }
    const settleMessage = id => {
      const plan = plans.get(id)
      if (plan === undefined) return
      const target = sessions[plan.target]
      target.open.delete(id)
      target.openFrom.set(plan.from, Math.max(0, (target.openFrom.get(plan.from) ?? 0) - 1))
    }
    const dismiss = async id => {
      const answer = await hub('dismiss', { id })
      if (answer.status !== 200) unexpected('dismiss', answer, sessions[plans.get(id)?.target])
      settleMessage(id)
    }

    // One send. `from` is a session (an agent sending: its source and secret go along), or undefined
    // for the page. The plan is kept before the send, since the receiver may poll right after it.
    // `expects` is the refusal this send is meant to provoke (PAIR_BUSY, TARGET_BUSY, CONTESTED), or
    // undefined for a send meant to be accepted. A provoked send the hub accepted did not do its job,
    // so it is an unexpected answer and not a message sent; one refused with another code is too.
    const hold = { isActive: false, held: new Map() }
    const sendMessage = async (from, target, outcome, expects) => {
      const id = `AB-${randomUUID()}`
      const fromKey = from === undefined ? 'board' : from.number
      plans.set(id, { outcome, target: target.number, from: fromKey })
      target.busy += 1
      if (from !== undefined) from.busy += 1
      const body = { id, target: target.conn.id, turn: target.turn, text: `Check the ${TOPICS[tally.sent % TOPICS.length]} for task ${target.number + 1}`, ...(from === undefined ? {} : { source: from.conn.id, secret: from.conn.secret }) }
      const answer = await timed('send', () => hub('send', body))
      target.busy -= 1
      if (from !== undefined) from.busy -= 1
      if (answer.status === 200) {
        // The hub counts a hop from the last message claimed for the sender, which can be claimed before
        // this harness hears of it; so a session with a second-hop message still open sends nothing.
        plans.get(id).hops = answer.json.hops ?? 0
        // The hub holds the message whatever was meant, so the soak keeps track of it.
        target.open.add(id)
        target.openFrom.set(fromKey, (target.openFrom.get(fromKey) ?? 0) + 1)
        if (outcome === 'dismiss') later(between(80, 400), () => dismiss(id))
        if (expects !== undefined) {
          unexpected('send', { status: 200, json: { error: `accepted although ${expects} was expected` } }, target)
          return id
        }
        tally.sent += 1
        byOutcome[outcome] += 1
        sentLog.push({ at: Date.now(), sent: tally.sent })
        if (tally.sent % SAMPLE_EVERY === 0) takeSample('messages')
        return id
      }
      plans.delete(id)
      const code = answer.json?.error
      if (answer.status === 409 && REFUSALS.has(code) && code === expects) refused[code] += 1
      // A busy or contested refusal on a send that was to be accepted is rare and tolerated, but counted apart.
      else if (answer.status === 409 && REFUSALS.has(code) && expects === undefined) unasked[code] += 1
      else unexpected('send', answer, target)
      return undefined
    }

    // A session's receiver: polls every 2 to 5 seconds, as a connector does, and answers what it is
    // given by the message's plan.
    const startReceiver = (session, conn = session.conn) => {
      const handle = { isStopped: false, done: undefined }
      handle.done = (async () => {
        await sleep(between(300, 2000))
        while (isRunning() && !handle.isStopped) {
          const started = Date.now()
          const answer = await timed('receiver poll', () => hub('poll', { connection: conn.id, secret: conn.secret, turn: session.turn }))
          if (answer.status !== 200) unexpected('poll', answer, session)
          else {
            session.leaseFloor = started
            session.lastPollEnd = Date.now()
            for (const message of answer.json.messages) await respond(session, conn, message)
          }
          // An idle receiver asks again in 2 to 5 seconds; one that was just given a message asks
          // sooner, as a connector draining its queue does.
          if (isRunning() && !handle.isStopped) await sleep(answer.status === 200 && answer.json.messages.length > 0 ? between(300, 800) : between(2000, 5000))
        }
      })()
      return handle
    }
    const receipt = async (session, conn, message, fields) => {
      const answer = await timed('receipt', () => hub('receipt', { connection: conn.id, secret: conn.secret, id: message.id, nonce: message.nonce, ...fields }))
      if (answer.status !== 200) unexpected('receipt', answer, session)
      else receipts[fields.status] = (receipts[fields.status] ?? 0) + 1
      return answer.status === 200
    }
    const respond = async (session, conn, message) => {
      tally.claimed += 1
      session.lastHops = message.hops
      const plan = plans.get(message.id)
      const outcome = plan?.outcome ?? 'ack'
      if (hold.isActive && outcome === 'hold') {
        // Claimed and not answered: the hub is killed with this in flight. Every third one reports
        // that the transport accepted it, so accepted messages are in flight too.
        hold.held.set(message.id, { session: session.number, nonce: message.nonce })
        if (hold.held.size % 3 === 0) await receipt(session, conn, message, { status: 'accepted' })
        return
      }
      if (session.dropOnClaim || outcome === 'drop') {
        await dropSession(session)
        return
      }
      await sleep(between(20, 200))
      if (outcome === 'dismiss') return
      let isDone = false
      if (outcome === 'reject') isDone = await receipt(session, conn, message, { status: 'rejected', error: 'NOT_READY' })
      else if (outcome === 'uncertain') {
        isDone = await receipt(session, conn, message, { status: 'uncertain', error: 'ACK_TIMEOUT' })
        // The person clears most of these from the card; the few left keep their session from receiving more.
        if (isDone && random() < 0.95) { later(between(1000, 3000), () => dismiss(message.id)); return }
        if (isDone) { session.stuck = true; return }
      } else isDone = await receipt(session, conn, message, { status: 'acknowledged', reply: random() < 0.5 ? `ACK ${message.nonce}` : `ACK ${message.nonce} done` })
      if (isDone) { tally.answered += 1; settleMessage(message.id) }
    }
    // A receiver that disconnects right after a claim leaves the message uncertain.
    const dropSession = async session => {
      if (session.hasDropped || session.state === 'ended') return
      session.hasDropped = true
      session.receiver.isStopped = true
      session.endBeginAt = session.endBeginAt || Date.now()
      const answer = await hub('disconnect', { connection: session.conn.id, secret: session.conn.secret, turn: session.turn })
      if (answer.status !== 200) unexpected('disconnect', answer, session)
      finishEnd(session, 'disconnect')
    }
    const finishEnd = (session, kind) => {
      session.endKind = kind
      session.endedAt = Date.now()
      session.state = 'ended'
      tally.ended += 1
      if (kind === 'disconnect') tally.endedByDisconnect += 1
      else tally.endedByExpiry += 1
      writeBlock(session, 'ended')
    }

    // One registration with the hub; the connection and its secret come back (undefined when refused).
    const register = async session => {
      const answer = await hub('register', { agent: session.agent, session: session.id, surface: 'Synthetic soak receiver', turn: session.turn })
      if (answer.status !== 200) { unexpected('register', answer); return undefined }
      return { id: answer.json.id, secret: answer.json.secret, contested: answer.json.contested === true }
    }
    // A session comes in once the hub has room: never more than 100 connections are asked for. Those
    // waiting for room wake together, so each takes its place before it asks and looks again first.
    let connecting = 0
    const connect = async (session, isDuplicate = false) => {
      while (isRunning()) {
        await until(() => connectionsHeld() + connecting < LIVE_SESSIONS, 120000)
        if (connectionsHeld() + connecting < LIVE_SESSIONS) break
      }
      connecting += 1
      let conn
      const started = Date.now()
      try { conn = await register(session) } finally { connecting -= 1 }
      if (conn === undefined) return undefined
      if (isDuplicate) return conn
      tally.registered += 1
      session.conn = conn
      session.contested = conn.contested
      session.leaseFloor = started
      session.registeredAt = Date.now()
      session.lastPollEnd = session.registeredAt
      session.state = 'live'
      writeBlock(session, 'working')
      session.receiver = startReceiver(session)
      tally.mostLive = Math.max(tally.mostLive, liveSessions().length)
      return conn
    }
    // The same agent and session registering again: both connections are contested from then on.
    // A contested connection's receipt is refused CONTESTED, as it should be, so a session is
    // contested only once it holds nothing: nothing new is sent to it from here on, and it
    // registers again once what it holds is answered.
    const connectDuplicate = async session => {
      session.isContesting = true
      const isQuiet = () => session.state === 'live' && session.open.size === 0 && session.busy === 0
      if (!await until(isQuiet, 30000)) { session.isContesting = false; tally.duplicatesSkipped += 1; return }
      const conn = await connect(session, true)
      if (conn === undefined) { session.isContesting = false; return }
      tally.duplicates += 1
      session.contested = true
      const copy = { number: session.number, state: 'live', conn, leaseFloor: Date.now(), turn: session.turn }
      duplicates.add(copy)
      copy.receiver = startReceiver(copy, conn)
      later(between(15000, 25000), async () => {
        copy.receiver.isStopped = true
        await copy.receiver.done
        const answer = await hub('disconnect', { connection: conn.id, secret: conn.secret, turn: session.turn })
        if (answer.status !== 200) unexpected('disconnect', answer)
        copy.state = 'ended'
      })
    }

    // Ending a session: nothing new is sent to it, what it holds is answered, then it goes, either by
    // disconnecting (with a message dropped on its last claim, for half of them) or by simply not polling
    // again, so its lease runs out.
    const endSession = async (number, kind) => {
      // It may still be on its way in when its turn to end comes.
      await until(() => sessions[number]?.state === 'live', 120000)
      const session = sessions[number]
      if (session?.state !== 'live') return
      session.state = 'ending'
      session.endBeginAt = Date.now()
      if (kind === 'disconnect') {
        // One last message that its receiver will drop after claiming it.
        if (!session.stuck && session.contested === false && !session.isContesting && session.open.size === 0) {
          session.dropOnClaim = true
          await sendMessage(undefined, session, 'drop')
        }
      }
      await until(() => session.busy === 0 && (session.open.size === 0 || session.stuck || session.state === 'ended'), 12000)
      if (session.state === 'ended') return
      session.receiver.isStopped = true
      await session.receiver.done
      if (kind === 'disconnect') {
        const answer = await hub('disconnect', { connection: session.conn.id, secret: session.conn.secret, turn: session.turn })
        if (answer.status !== 200) unexpected('disconnect', answer, session)
        finishEnd(session, 'disconnect')
      } else finishEnd(session, 'expiry')
    }

    // The page's poll: back to back with a gap after each answer. `observe` checks what the hub says
    // against what the soak knows of each connection.
    const pager = { isPaused: false, isStopped: false, isBusy: false, gap: 500, polls: [] }
    const observe = (board, start, end) => {
      const connections = board.messaging?.connections ?? []
      const messages = board.messaging?.messages ?? []
      const held = new Set(connections.map(one => one.id))
      lastBoard = { connections: connections.length, open: messages.filter(one => !isFinishedRecord(one)).length, finished: messages.filter(isFinishedRecord).length, all: messages.length }
      tally.mostConnections = Math.max(tally.mostConnections, connections.length)
      // Every page poll, not only the samples, so a brief rise past the cap is seen.
      store.openMost = Math.max(store.openMost, lastBoard.open)
      store.finishedMost = Math.max(store.finishedMost, lastBoard.finished)
      if (messages.some(one => 'hash' in one || 'nonce' in one)) { leaks.api += 1; leaks.example ??= 'a hash or nonce in the board\'s answer' }
      const leaks_ = messages.filter(one => isFinishedRecord(one) && one.text !== '')
      if (leaks_.length > 0) { leaks.api += leaks_.length; leaks.example ??= `${leaks_[0].id} (${leaks_[0].status})` }
      // The receivers answer `ACK <nonce>` or `ACK <nonce> done`; the board must show the reply without the nonce.
      const nonced = messages.filter(one => typeof one.reply === 'string' && /^ACK [0-9a-f]{6}\b/.test(one.reply))
      if (nonced.length > 0) { leaks.replies += nonced.length; leaks.example ??= `${nonced[0].id} still began its reply with the nonce` }
      for (const session of sessions) {
        if (session?.conn === undefined) continue
        const isHeld = held.has(session.conn.id)
        // Gone for good: disconnected before the poll began, or silent past the lease.
        const isGone = session.endKind === 'disconnect' ? start > session.endedAt + 200 : session.endKind === 'expiry' ? start > session.lastPollEnd + LEASE_MS + 500 : false
        // Still owed: live, and the lease from its last completed poll covers the whole snapshot.
        const isOwed = session.state === 'live' && session.registeredAt > 0 && start > session.registeredAt + 50 && end < session.leaseFloor + LEASE_MS
        if (isGone && isHeld) { invariants.ghosts += 1; invariants.example ??= `an ended session was still listed (${session.endKind})` }
        if (isOwed && !isHeld) { invariants.missing += 1; invariants.example ??= 'a live session was missing from the hub' }
      }
    }
    const pageLoop = async () => {
      while (isRunning() && !pager.isStopped) {
        if (pager.isPaused) { await sleep(100); continue }
        pager.isBusy = true
        const start = Date.now()
        const answer = await timed('page poll', () => call('GET', '/api/board'))
        const end = Date.now()
        pager.isBusy = false
        pager.polls.push({ start, end, isOk: answer.status === 200 })
        if (answer.status === 200) observe(answer.json, start, end)
        else unexpected('page poll', answer)
        await sleep(pager.gap)
      }
    }

    // A sample every 10 s and every 250 messages: the hub's memory from the probe, the size of the
    // message file, the folder's file names, and how many open and finished messages the board lists.
    // The file itself is only read (isContent) when the hub is quiet: on Windows a reader can make the
    // hub's save of the file fail, which would be this soak's doing, not the hub's.
    const takeSample = (reason, { isContent = false } = {}) => {
      // A child's preload records its PID before publishing its claim. Capture
      // files first so a restarted child's identity is available for this scan.
      const files = readMessageStoreFiles(messagesDir)
      readProbe()
      messageFiles = classifyMessageStoreFiles(files, ownedServePids, messageFiles)
      const row = linesOf(server.pid).at(-1)
      let bytes
      try { bytes = statSync(join(messagesDir, 'messages.json')).size } catch (error) { if (error.code === 'ENOENT') bytes = 0 }
      if (isContent) {
        const found = readFileStore()
        if (found !== undefined) {
          scanRecords(found.records)
          bytes = found.bytes
        }
      }
      const open = lastBoard?.open
      const finished = lastBoard?.finished
      if (bytes !== undefined) store.bytesMost = Math.max(store.bytesMost, bytes)
      store.openMost = Math.max(store.openMost, open ?? 0)
      store.finishedMost = Math.max(store.finishedMost, finished ?? 0)
      if (bytes !== undefined && settle.sent === undefined && tally.sent >= settle.goal && (finished ?? 0) >= FINISHED_CAP) settle = { ...settle, sent: tally.sent, bytes, at: Date.now() }
      const seconds = Math.round(since() / 1000)
      series.push({ seconds, reason, sent: tally.sent, rssMb: row === undefined ? undefined : Number((row.rss / MEGABYTE).toFixed(1)), fileKb: bytes === undefined ? undefined : Math.round(bytes / 1024), open, finished, hubConnections: lastBoard?.connections })
      report.memory = probeRows.filter(one => one.pid === firstPid).map(one => ({ seconds: Math.round((one.at - epoch0) / 1000), bytes: one.rss, heap: one.heap }))
      report.traffic = trafficNow()
    }
    const epoch0 = performance.timeOrigin + t0
    const summary = list => list.length === 0 ? undefined : { count: list.length, median: median(list), p95: percentile(list, 0.95), max: Math.max(...list) }
    const trafficNow = () => ({
      ...tally, failures: failures.count, races: failures.races, refused: { ...refused }, unasked: { ...unasked }, receipts: { ...receipts }, byOutcome: { ...byOutcome },
      latency: Object.fromEntries(Object.entries(latency).map(([name, list]) => [name, summary(list)]).filter(([, one]) => one !== undefined)),
    })
    const sampler = setInterval(() => { takeSample('time'); save() }, SAMPLE_MS)
    settle.goal = Infinity

    // ---- setup: the hooks of three hosts run once, untimed, to install and warm them up
    setPhase('setup')
    for (const [host, event] of HOOKS.filter(([, name]) => name !== 'SessionStart')) {
      const result = await hook(world, host, event, { session_id: `soak-msg-${host}-warm`, prompt: 'Warm up the hook', cwd: world.root }).catch(error => ({ status: -1, stderr: String(error.message) }))
      if (result.status !== 0) problem(`A ${host} ${event} hook call exited with ${result.status} while warming up.`)
    }
    pager.polls.length = 0
    const pageRun = pageLoop()
    pager.isPaused = true

    // ---- baseline: 10 registered, polling sessions
    setPhase('baseline')
    for (let number = 0; number < BASELINE; number += 1) await connect(makeSession(number))
    await sleep(8000)

    // File operations per poll over two probe windows of 20 s: first the receivers alone, so every
    // request is an idle receiver poll, then the page polling beside them. The page's share is what
    // is left once the receiver polls (counted from the requests the hub saw) are taken off.
    const measureOps = async name => {
      pager.isPaused = true
      await until(() => !pager.isBusy, 30000)
      const mark = Date.now()
      const first = await lineAfter(30000, row => row.at > mark)
      if (first === undefined) return undefined
      const idleEnd = await lineAfter(40000, row => row.at >= first.at + WINDOW_MS - 500)
      if (idleEnd === undefined) return undefined
      pager.gap = 250
      pager.isPaused = false
      const pageEnd = await lineAfter(40000, row => row.at >= idleEnd.at + WINDOW_MS - 500)
      pager.isPaused = true
      pager.gap = 500
      if (pageEnd === undefined) return undefined
      const pages = pager.polls.filter(one => one.isOk && one.start >= idleEnd.at && one.end <= pageEnd.at).length
      const idleOps = idleEnd.ops - first.ops
      const idlePolls = idleEnd.requests - first.requests
      const idle = idlePolls > 0 ? idleOps / idlePolls : undefined
      const receiverPolls = pageEnd.requests - idleEnd.requests - pages
      const page = pages > 0 && idle !== undefined ? ((pageEnd.ops - idleEnd.ops) - receiverPolls * idle) / pages : undefined
      const found = { idle, page, idlePolls, pages, seconds: Math.round((pageEnd.at - first.at) / 1000), live: liveSessions().length, finished: lastBoard?.finished }
      report.ops[name] = found
      say(`messaging soak: file operations at ${name}: ${idle?.toFixed(2)} per idle receiver poll, ${page?.toFixed(1)} per page poll (${idlePolls} receiver polls, ${pages} page polls)`)
      return found
    }
    const baselineOps = await measureOps('10 sessions')
    pager.polls.length = 0
    pager.isPaused = false

    // ---- growth: sessions come and go, messages flow
    // The rest of the planned time, after what the later phases need, goes to growth.
    const overhead = 210000
    const growthMs = Math.max(60000, total - since() - overhead)
    const rate = Math.min(MAX_RATE, MESSAGES / (0.9 * growthMs / 1000))
    const planned = Math.round(rate * 0.9 * growthMs / 1000)
    // The file settles once the store holds its 1,000 finished messages, and not before 2,000 are sent (a short run: sooner).
    settle.goal = Math.min(SETTLE_SENT, Math.round(0.6 * planned))
    setPhase('growth')
    report.planned = { growthSeconds: Math.round(growthMs / 1000), messages: planned, perSecond: Number(rate.toFixed(1)), settleAt: settle.goal }
    const growthStart = Date.now()
    let scheduled = 0
    const at = (fraction, work) => {
      scheduled += 1
      later(fraction * growthMs, async () => { try { await work() } finally { scheduled -= 1 } })
    }
    // 90 more sessions come in over the first 15%; ten of them are registered a second time soon after.
    for (let number = BASELINE; number < ENDING; number += 1) {
      const fraction = 0.15 * (number - BASELINE) / (ENDING - BASELINE)
      at(fraction, () => connect(makeSession(number)))
      if (number >= 40 && number < 40 + DUPLICATES) at(fraction + 4000 / growthMs, () => connectDuplicate(sessions[number]))
    }
    // From 35% to 95% one session ends and one more comes in, so 100 are live and 100 have ended.
    for (let at_ = 0; at_ < ENDING; at_ += 1) {
      const fraction = 0.35 + 0.6 * at_ / ENDING
      const kind = at_ % 2 === 0 ? 'disconnect' : 'expiry'
      // A session starts ending early enough to be gone when its replacement comes (a lease runs
      // 15 seconds), as far as a short run allows.
      const lead = Math.min(kind === 'disconnect' ? 20000 : 24000, 0.12 * growthMs)
      at(Math.max(0, fraction - lead / growthMs), () => endSession(at_, kind))
      at(fraction, () => connect(makeSession(ENDING + at_)))
    }

    // The senders: the page (no source) and agents (source and secret), paced to the plan; each to a
    // live receiver that has room, so a refusal is rare and counted.
    let inFlight = 0
    let isSending = true
    const isFree = (session, fromKey) => session.state === 'live' && !session.contested && !session.isContesting && !session.stuck && Date.now() - session.registeredAt > 1500 && session.open.size < OPEN_MOST && (session.openFrom.get(fromKey) ?? 0) === 0 && session.busy === 0
    const pick = list => list.length === 0 ? undefined : list[Math.floor(random() * list.length)]
    const canForward = one => one.lastHops <= 1 && ![...one.open].some(id => (plans.get(id)?.hops ?? 0) >= 2)
    const sendOne = async () => {
      const isAgent = random() < 0.45
      const sender = isAgent ? pick(liveSessions().filter(one => !one.contested && !one.stuck && canForward(one) && one.busy === 0 && Date.now() - one.registeredAt > 1500)) : undefined
      const fromKey = sender === undefined ? 'board' : sender.number
      const target = pick(liveSessions().filter(one => one !== sender && isFree(one, fromKey)))
      if (target === undefined) return false
      await sendMessage(sender, target, draw())
      return true
    }
    // Every 250 messages the soak asks for the refusals it expects: a second message from the same
    // sender, a fourth to one target, and one to a contested session. Each of these sends names the
    // refusal it must get. The person's first message and the first agents' fill the target up to its
    // cap and are accepted; the one after the cap is the fourth.
    let provoked = 0
    const provoke = async () => {
      const free = liveSessions().filter(one => !one.contested && !one.isContesting && !one.stuck && one.open.size === 0 && one.busy === 0 && Date.now() - one.registeredAt > 1500)
      const target = pick(free)
      if (target !== undefined) {
        await sendMessage(undefined, target, 'ack')
        await sendMessage(undefined, target, 'ack', 'PAIR_BUSY')
        const agents = liveSessions().filter(one => one !== target && !one.contested && !one.stuck && canForward(one) && one.busy === 0)
        for (let one = 0; one < TARGET_CAP && agents.length > 0; one += 1) await sendMessage(agents.splice(Math.floor(random() * agents.length), 1)[0], target, 'ack', one === TARGET_CAP - 1 ? 'TARGET_BUSY' : undefined)
      }
      const contested = pick(sessions.filter(one => one?.contested && one.conn !== undefined && one.state === 'live'))
      if (contested !== undefined) await sendMessage(undefined, contested, 'ack', 'CONTESTED')
    }
    const sendLoop = (async () => {
      while (isRunning() && isSending && tally.sent < planned) {
        if (inFlight < 3 && Date.now() >= growthStart + (tally.sent + inFlight) / rate * 1000) {
          if (Math.floor(tally.sent / SAMPLE_EVERY) > provoked) {
            provoked += 1
            await provoke()
            continue
          }
          inFlight += 1
          sendOne().then(isSent => { if (!isSent) return sleep(50) }).finally(() => { inFlight -= 1 })
        }
        await sleep(10)
      }
    })()
    // Growth lasts its planned time, or until the messages are all sent.
    await until(() => scheduled === 0 && (tally.sent >= planned || Date.now() >= growthStart + growthMs * 1.05), growthMs * 1.3 + 30000)
    isSending = false
    await sendLoop
    await until(() => inFlight === 0, 30000)
    takeSample('growth end')
    growthEndedAt = Date.now()
    if (!isRunning()) throw new Error('stopped')

    // ---- drain: everything still open is answered or stuck; the live count is checked against the hub
    setPhase('drain')
    await until(() => liveSessions().every(one => one.stuck || one.open.size === 0), 30000)
    await sleep(LEASE_MS + 3000)
    takeSample('drained', { isContent: true })
    const quiet = await call('GET', '/api/board')
    const live = liveSessions()
    const hubIds = new Set((quiet.json.messaging?.connections ?? []).map(one => one.id))
    const unlisted = live.filter(one => !hubIds.has(one.conn.id)).length
    const listedEnded = sessions.filter(one => one?.state === 'ended' && hubIds.has(one.conn.id)).length
    const strict = { live: live.length, hub: hubIds.size, unlisted, listedEnded }
    const finalBoard = quiet.json.messaging?.messages ?? []
    const histogram = {}
    for (const one of finalBoard) { const key = `${one.status}${one.error ? ` ${one.error}` : ''}`; histogram[key] = (histogram[key] ?? 0) + 1 }
    report.endState = histogram

    // ---- final polls: 100 live receivers, 200 blocks, a full store
    setPhase('final')
    pager.polls.length = 0
    const finalOps = await measureOps('200 sessions')
    pager.isPaused = true

    // ---- hooks: each host's session-start and prompt hooks, timed, beside the live hub
    setPhase('hooks')
    for (const [host, event] of HOOKS) {
      const times = []
      for (let again = 0; again < 3 && isRunning(); again += 1) {
        const start = performance.now()
        const result = await hook(world, host, event, { session_id: `soak-msg-${host}-${again}`, prompt: `Soak messaging task ${again + 1}`, cwd: world.root }).catch(error => ({ status: -1, stderr: String(error.message) }))
        const ms = Math.round(performance.now() - start)
        times.push(result.status === 0 ? ms : Infinity)
        if (result.status !== 0) problem(`A ${host} ${event} hook call exited with ${result.status}.`)
      }
      report.hooks.push({ host, event, limit: hookTimeout(host, event), msMost: Math.max(...times), times })
    }

    // ---- crash: claimed messages in flight, the hub killed, started again
    setPhase('crash')
    pager.isStopped = true
    await pageRun
    hold.isActive = true
    const candidates = liveSessions().filter(one => !one.stuck && !one.contested && !one.isContesting && one.open.size === 0 && one.busy === 0)
    const chosen = []
    while (chosen.length < HELD && candidates.length > 0) chosen.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0])
    const heldIds = []
    for (const target of chosen) {
      const id = await sendMessage(undefined, target, 'hold')
      if (id !== undefined) heldIds.push(id)
    }
    const isHeld = await until(() => hold.held.size >= heldIds.length, 30000)
    for (const one of liveSessions()) one.receiver.isStopped = true
    await Promise.all(liveSessions().map(one => one.receiver.done))
    const beforeKill = await call('GET', '/api/board')
    const claimedBefore = new Map(hold.held)
    const finishedBefore = new Map((beforeKill.json.messaging?.messages ?? []).filter(isFinishedRecord).map(one => [one.id, one]))
    const killedAt = performance.now()
    const wasKilled = await killServe(server)
    const lockOfDead = (() => { try { return readFileSync(join(messagesDir, 'server.lock'), 'utf8') } catch { return undefined } })()
    const deadPid = server.pid
    let restarted
    if (wasKilled) {
      try { restarted = await serve.start(world, serveArgs, serveOptions) } catch (error) { problem(`The hub did not start again: ${String(error.message).split('\n')[0]}`) }
    }
    const crash = { heldAsked: heldIds.length, held: claimedBefore.size, isHeld, wasKilled, hasStaleLock: lockOfDead === String(deadPid), restartMs: undefined, problems: [] }
    if (restarted !== undefined) {
      crash.restartMs = Math.round(performance.now() - killedAt)
      server = restarted
      ownedServePids.add(server.pid)
      secrets.push(server.url, new URL(server.url).search, token())
      const lockNow = (() => { try { return readFileSync(join(messagesDir, 'server.lock'), 'utf8') } catch { return undefined } })()
      if (lockNow !== String(server.pid)) crash.problems.push('the lock does not name the new hub')
      const after = await call('GET', '/api/board')
      const messages = after.json.messaging?.messages ?? []
      const byId = new Map(messages.map(one => [one.id, one]))
      if ((after.json.messaging?.connections ?? []).length !== 0) crash.problems.push('the new hub holds connections it never took')
      const notUncertain = [...claimedBefore.keys()].filter(id => byId.get(id)?.status !== 'uncertain')
      if (notUncertain.length > 0) crash.problems.push(`${notUncertain.length} of ${claimedBefore.size} claimed messages did not come back uncertain`)
      // The restart is what ended their receivers' connections, and the board says so in the error. These
      // messages stay open, which is why the polls below hand out nothing until they are settled.
      const notDisconnected = [...claimedBefore.keys()].filter(id => byId.get(id)?.error !== 'DISCONNECTED')
      if (notDisconnected.length > 0) crash.problems.push(`${notDisconnected.length} of ${claimedBefore.size} claimed messages did not come back with the error DISCONNECTED`)
      if (messages.some(one => 'nonce' in one)) crash.problems.push('the board shows a nonce')
      // The restart ends every open message whose receiver is gone, so they join the finished ones and
      // the oldest finished go past the cap. A finished message may leave only that way: when the store
      // is at the cap and every finished message it kept is at least as new. A message handed out and then
      // expired or dismissed, and each session's latest delivery, outlast the count however old they
      // are, so only the others say where the count stopped.
      const finishedAfter = messages.filter(isFinishedRecord)
      const latestOf = new Map()
      for (const one of messages) if (one.claimed > 0 && one.claimed >= (latestOf.get(one.to)?.claimed ?? 0)) latestOf.set(one.to, one)
      const droppable = finishedAfter.filter(one => !(one.status === 'uncertain' && one.claimed > 0) && latestOf.get(one.to) !== one)
      // With nothing the count could drop, every finished message that left was lost.
      const oldestKept = droppable.length === 0 ? -Infinity : Math.min(...droppable.map(one => one.updated))
      const gone = [...finishedBefore.values()].filter(one => !byId.has(one.id))
      const lostFinished = finishedAfter.length < FINISHED_CAP ? gone.length : gone.filter(one => one.updated > oldestKept).length
      crash.finishedOverCap = gone.length - lostFinished
      if (lostFinished > 0) crash.problems.push(`${lostFinished} finished messages were not kept across the restart`)
      // The receivers register again as the same sessions and ask for their messages: none comes.
      crash.handedOut = 0
      const again = liveSessions()
      for (const session of again) {
        const conn = await register(session)
        if (conn === undefined) { crash.problems.push('a receiver could not register again'); continue }
        session.conn = conn
        for (let asks = 0; asks < 2; asks += 1) {
          const poll = await hub('poll', { connection: conn.id, secret: conn.secret, turn: session.turn })
          if (poll.status !== 200) { unexpected('poll after the restart', poll, session); continue }
          crash.handedOut += poll.json.messages.length
        }
      }
      if (crash.handedOut > 0) crash.problems.push(`${crash.handedOut} messages were handed out again`)
      // The nonce each receiver was given before the kill still settles its message.
      let settled = 0
      for (const [id, claim] of claimedBefore) {
        const session = sessions[claim.session]
        const answer = await hub('receipt', { connection: session.conn.id, secret: session.conn.secret, id, nonce: claim.nonce, status: 'acknowledged', reply: `ACK ${claim.nonce}` })
        if (answer.status === 200) settled += 1
        else crash.problems.push(`a receipt with the original nonce was refused (${answer.json?.error ?? answer.status})`)
      }
      const settledBoard = (await call('GET', '/api/board')).json.messaging?.messages ?? []
      const settledById = new Map(settledBoard.map(one => [one.id, one]))
      const notAcknowledged = [...claimedBefore.keys()].filter(id => settledById.get(id)?.status !== 'acknowledged' || settledById.get(id)?.text !== '').length
      if (notAcknowledged > 0) crash.problems.push(`${notAcknowledged} messages did not show as acknowledged, without text, after their receipts`)
      crash.settled = settled
      // The empty polls above mean something only if a poll hands a message out once there is one to
      // hand out. A claimed message left open keeps its receiver from being given another, so this
      // waits for the receipts: with its old message settled, a fresh one for the same receiver is
      // what its next poll returns, and only that.
      crash.isFreshHandedOut = false
      const fresh = [...claimedBefore.values()].map(claim => sessions[claim.session]).find(session => session?.state === 'live' && session.conn !== undefined)
      if (fresh === undefined) crash.problems.push('no receiver was left to be given a fresh message after the restart')
      else {
        const freshId = `AB-${randomUUID()}`
        const queued = await hub('send', { id: freshId, target: fresh.conn.id, turn: fresh.turn, text: 'Check that a poll still hands a new message out after the restart' })
        if (queued.status !== 200) crash.problems.push(`a fresh message after the restart was refused (${queued.json?.error ?? queued.status})`)
        else {
          const poll = await hub('poll', { connection: fresh.conn.id, secret: fresh.conn.secret, turn: fresh.turn })
          const handed = poll.status === 200 ? poll.json.messages : undefined
          if (handed === undefined) crash.problems.push(`the poll for a fresh message after the restart was answered ${poll.status}`)
          else if (handed.length !== 1 || handed[0].id !== freshId) crash.problems.push(`the poll for a fresh message after the restart returned ${handed.length} messages${handed.length === 1 ? ' and not the fresh one' : ''}`)
          else {
            crash.isFreshHandedOut = true
            // Answered, so no open message is left behind.
            const done = await hub('receipt', { connection: fresh.conn.id, secret: fresh.conn.secret, id: freshId, nonce: handed[0].nonce, status: 'acknowledged', reply: `ACK ${handed[0].nonce}` })
            if (done.status !== 200) crash.problems.push(`the receipt for the fresh message was refused (${done.json?.error ?? done.status})`)
          }
        }
      }
    } else crash.problems.push(wasKilled ? 'the hub did not start again' : 'the hub could not be ended')
    crash.line = crash.problems.length === 0
      ? `${crash.held} claimed messages in flight (some accepted) when the hub was killed; it started again after ${crash.restartMs} ms, recovering the stale lock; all of them came back uncertain with the error DISCONNECTED, ${crash.handedOut} were handed out again, and ${crash.settled} receipts with the original nonce were accepted; once those were settled, a fresh message was the only one its receiver's next poll returned; ${crash.finishedOverCap ?? 0} of the oldest finished messages went past the cap of ${count(FINISHED_CAP)} as the restart ended the open ones.`
      : `${crash.problems.join('; ')}.`
    report.crash = crash
    pager.isStopped = false
    save()

    // ---- retire: the clock jumps past the 24 hours finished messages are kept, then past three days
    setPhase('retire')
    const beforeJump = readFileStore()
    // The text the file holds before the jump is looked at too: a finished message that kept its text would be deleted with the rest.
    if (beforeJump !== undefined) scanRecords(beforeJump.records)
    const finishedIds = new Set((beforeJump?.records ?? []).filter(isFinishedRecord).map(one => one.id))
    const afterJump = []
    for (let round = 1; round <= 3 && isRunning(); round += 1) {
      world.jump(JUMP)
      await sleep(600)
      const board = await call('GET', '/api/board')
      const found = readFileStore()
      // A file that could not be read tells nothing about what was left in it, so it is not a count of 0.
      afterJump.push({ round, board: board.status === 200, isUnreadable: found === undefined, finishedKept: (found?.records ?? []).filter(one => finishedIds.has(one.id)).length, records: found?.records.length, finished: (found?.records ?? []).filter(isFinishedRecord).length, connections: board.json.messaging?.connections?.length })
    }
    report.retire = { finishedBefore: finishedIds.size, rounds: afterJump }

    // ---- archive: the ended sessions' blocks go on the board's three-day schedule for stopped blocks
    setPhase('archive')
    for (const session of liveSessions()) writeBlock(session, 'working')
    const tidy = await run(world, ['--tidy'])
    if (tidy.status !== 0) problem(`The board's scheduled tidy exited with ${tidy.status}.`)
    const present = new Set([...readFileSync(world.path, 'utf8').matchAll(/^<!-- auto session=([a-f0-9]+) /gm)].map(one => one[1]))
    const folder = dirname(world.path)
    const archivedTitles = new Set(readdirSync(folder).filter(name => /-archive-\d{4}-\d{2}\.md$/.test(name))
      .flatMap(name => readFileSync(join(folder, name), 'utf8').split(/\r?\n/).filter(line => line.startsWith('### ')).map(line => line.slice(4))))
    const planned_ = sessions.filter(one => one?.conn !== undefined).map(one => ({ session: one.blockId, title: one.title, isStopped: one.endKind !== undefined }))
    const stopped = planned_.filter(one => one.isStopped)
    const integrity = archiveIntegrity({ planned: planned_, answered: new Set(stopped.map(one => one.session)), unpressed: new Set(), present, archivedTitles, others: [] })
    const liveGone = planned_.filter(one => !one.isStopped && !present.has(one.session)).length
    const archive = { integrity, liveGone, stopped: stopped.length, live: planned_.length - stopped.length, problems: archiveProblems(integrity) }
    if (liveGone > 0) archive.problems.push(`${liveGone} live sessions' blocks left progress.md`)

    // ---- the checks
    clearInterval(sampler)
    setPhase('checks')
    takeSample('final privacy', { isContent: true })
    const hubRows = linesOf(firstPid)
    const outcomes = {}
    const unmeasured = text => ({ skipped: text })

    // The traffic passes only if the scenario ran at its size: every session registered, nearly all
    // the messages sent (a short run is held to its own plan), each refusal the soak provokes got, and
    // receivers that acknowledged, rejected and left messages uncertain. A run that sent nothing
    // of the kind has answered every request it made and tested nothing.
    const wantedSent = Math.floor(SENT_SHARE * (isFullRun ? MESSAGES : planned))
    const shortfalls = []
    if (tally.registered < 2 * ENDING) shortfalls.push(`only ${count(tally.registered)} sessions registered, ${count(2 * ENDING)} are needed`)
    if (tally.sent < wantedSent) shortfalls.push(`only ${count(tally.sent)} messages were sent, ${count(wantedSent)} are needed`)
    for (const code of Object.keys(refused)) if (refused[code] === 0) shortfalls.push(`no send was refused ${code}`)
    // A session still holding a message after 30 s is not contested; a few may be (stuck ones never
    // go quiet), but most of the planned ones must be.
    if (isFullRun && tally.duplicates < DUPLICATES / 2) shortfalls.push(`only ${count(tally.duplicates)} sessions were registered twice, ${count(DUPLICATES / 2)} are needed (${count(tally.duplicatesSkipped)} still held a message after 30 s)`)
    const unaskedAll = Object.values(unasked).reduce((sum, many) => sum + many, 0)
    if (unaskedAll > UNASKED_SHARE * tally.sent) shortfalls.push(`${count(unaskedAll)} sends meant to be accepted were refused busy or contested, more than ${UNASKED_SHARE * 100}% of ${count(tally.sent)}`)
    for (const status of ['acknowledged', 'rejected', 'uncertain']) if (receipts[status] === 0) shortfalls.push(`no receiver's receipt was ${status}`)
    outcomes.traffic = {
      ok: failures.count === 0 && shortfalls.length === 0,
      line: `${count(tally.sent)} messages were sent and accepted (planned ${count(planned)}, at least ${count(wantedSent)} needed); ${count(refused.TARGET_BUSY)} TARGET_BUSY, ${count(refused.PAIR_BUSY)} PAIR_BUSY and ${count(refused.CONTESTED)} CONTESTED refusals came back, each to a send that was meant to be refused that way; receivers' receipts accepted: ${count(receipts.acknowledged)} acknowledged, ${count(receipts.rejected)} rejected, ${count(receipts.uncertain)} uncertain; ${count(tally.registered)} sessions registered; ${count(tally.requests)} requests, ${count(failures.count)} unexpected failures${Object.keys(failures.byKind).length > 0 ? ` (${Object.entries(failures.byKind).map(([key, many]) => `${key} x${many}`).join('; ')})` : ''}, ${count(failures.races)} calls raced the end of a session the soak was ending.${shortfalls.length > 0 ? ` The scenario fell short:${shortfalls.join('; ')}.` : ''}`,
    }

    // The hub's memory levels off once the store is full. It is judged by what the hub still holds
    // after a full collection (the probe asks for one before each line), since resident memory also
    // counts what the collector has yet to free and moves in steps of tens of MB. Each line is set
    // against the messages sent by the time it was written, and the slope of a straight line through
    // them, in bytes per message, may not pass its limit (liveMemoryLevel). The heap, where kept records
    // would sit, moves by about 100 KB between lines and is held to 256 bytes per message. External
    // memory (socket and request buffers) swings by several MB between lines whatever the hub keeps,
    // so it is held only to EXTERNAL_LIMIT: Buffers kept for each message show there only past a few KB.
    const sentBy = moment => {
      let sent = 0
      for (const one of sentLog) { if (one.at > moment) break; sent = one.sent }
      return sent
    }
    const sendingRows = hubRows.filter(row => settle.at !== undefined && row.at >= settle.at && row.at <= growthEndedAt && Number.isFinite(row.heapAfterGc) && Number.isFinite(row.external))
    const peak = hubRows.length === 0 ? undefined : Math.max(...hubRows.map(row => row.rss))
    const heap = liveMemoryLevel(sendingRows.map(row => ({ sent: sentBy(row.at), bytes: row.heapAfterGc })))
    const external = liveMemoryLevel(sendingRows.map(row => ({ sent: sentBy(row.at), bytes: row.external })), { limit: EXTERNAL_LIMIT })
    if (heap.skipped === undefined) report.memoryFit = { heapBytesPerMessage: Math.round(heap.bytesPerMessage), externalBytesPerMessage: Math.round(external.bytesPerMessage), messages: heap.messages, lines: heap.lines, points: sendingRows.map(row => ({ sent: sentBy(row.at), heapKb: Math.round(row.heapAfterGc / 1024), externalKb: Math.round(row.external / 1024) })) }
    if (hubRows.length === 0) outcomes.memory = { ok: false, line: 'The probe wrote nothing for the hub, so its memory could not be measured.' }
    else if (heap.skipped !== undefined) outcomes.memory = unmeasured(heap.skipped)
    else outcomes.memory = { ok: heap.ok && external.ok, line: `From ${count(settle.sent)} messages on, a straight line through ${heap.lines} memory lines over ${count(heap.messages)} messages, each taken after a full collection, rose ${heap.bytesPerMessage.toFixed(0)} bytes per message on the hub's heap (limit ${heap.limit}) and ${external.bytesPerMessage.toFixed(0)} in its external memory (limit ${external.limit}); its resident memory was ${megabytes(peak)} MB at the highest.` }

    report.store = { settleSent: settle.sent, bytesAtSettle: settle.bytes, bytesMost: store.bytesMost, openMost: store.openMost, finishedMost: store.finishedMost, unreadable: store.unreadable }
    if (settle.bytes === undefined) outcomes.store = unmeasured(`Only ${count(tally.sent)} messages were sent, ${count(settle.goal)} are needed to settle.`)
    else {
      const limit = 1.25 * settle.bytes
      const after = series.filter(one => one.sent >= settle.sent && one.fileKb !== undefined)
      const largest = Math.max(...after.map(one => one.fileKb * 1024), settle.bytes)
      outcomes.store = {
        ok: largest <= limit && store.finishedMost <= FINISHED_CAP,
        line: `The message file was ${kilobytes(settle.bytes)} KB once ${count(settle.sent)} messages were sent and ${kilobytes(largest)} KB at the largest after that (limit ${kilobytes(limit)} KB); it never held more than ${count(store.finishedMost)} finished messages (limit ${count(FINISHED_CAP)}), and at most ${count(store.openMost)} open ones.`,
      }
    }

    // A message file that was never read, or held no finished message when it was, shows nothing about
    // what finished messages keep; that fails the check and does not count as clean.
    const isFileRead = store.contentReads > 0 && store.finishedRead > 0
    outcomes.privacy = {
      ok: isFileRead && leaks.file === 0 && leaks.api === 0 && leaks.replies === 0 && isMessageStoreClean(messageFiles, server.pid) && store.unreadable <= 2,
      line: `${count(leaks.file)} finished messages in the file and ${count(leaks.api)} in the board's answer kept their text, and ${count(leaks.replies)} replies in the board's answer still began with their nonce${leaks.example ? ` (for example ${leaks.example})` : ''}; the file was read ${count(store.contentReads)} times with ${count(store.finishedRead)} finished messages in those reads${isFileRead ? '' : ', so what finished messages keep was never checked'}; ${messageFiles.stray.size === 0 ? 'the message folder held only messages.json, server.lock, temporary files and strictly validated claims of hubs started by this run' : `the message folder also held ${[...messageFiles.stray].join(', ')}`}; ${count(messageFiles.pending.size)} claim publications remain unverified and the final current-owner claim ${isMessageStoreClean(messageFiles, server.pid) ? 'was verified' : 'was not verified'}; ${count(store.unreadable)} reads of the file met a replacement and were skipped.`,
    }

    outcomes.registrations = {
      ok: invariants.ghosts === 0 && invariants.missing === 0 && strict.unlisted === 0 && strict.listedEnded === 0 && strict.hub === strict.live && tally.mostConnections <= LIVE_SESSIONS && tally.ended >= ENDING,
      line: `${count(tally.registered)} sessions registered and ${count(tally.ended)} ended (${count(tally.endedByDisconnect)} by disconnect, ${count(tally.endedByExpiry)} by letting the lease run out); the hub listed an ended session ${count(invariants.ghosts)} times and lacked a live one ${count(invariants.missing)} times${invariants.example ? ` (${invariants.example})` : ''}; once quiet it held ${strict.hub} connections for ${strict.live} live sessions; the most it held at once was ${tally.mostConnections} (limit ${LIVE_SESSIONS}).`,
    }

    const last = afterJump.at(-1)
    if (afterJump.length < 3) outcomes.retire = unmeasured('The clock jumps did not all happen.')
    else {
      // A round whose file could not be read is a failure: it would otherwise read as no message left.
      const isUnreadable = beforeJump === undefined || afterJump.some(one => one.isUnreadable)
      const held = one => (one.isUnreadable ? 'could not be read' : `held ${count(one.records)} records`)
      outcomes.retire = {
        ok: !isUnreadable && finishedIds.size > 0 && afterJump.every(one => one.board) && afterJump[0].finishedKept === 0 && last.records === 0,
        line: `${count(finishedIds.size)} finished messages were in the file before the first ${JUMP} jump${beforeJump === undefined ? ' (the file could not be read then)' : ''}; ${afterJump[0].isUnreadable ? 'after it the file could not be read' : `${count(afterJump[0].finishedKept)} of them were left after it (${count(afterJump[0].finished)} finished records, ${count(afterJump[0].records)} in all, the rest messages that ended with the jump)`}; after the second jump the file ${held(afterJump[1])} and after the third ${held(last)}.${isUnreadable ? ' A file that could not be read tells nothing about what was left, so this fails.' : ''}`,
      }
    }

    outcomes.archive = {
      ok: archive.problems.length === 0 && archive.integrity.archived >= archive.stopped,
      line: archive.problems.length === 0
        ? `${count(archive.integrity.archived)} of ${count(archive.stopped)} ended sessions' blocks were archived after the three-day jump and the scheduled tidy, and all ${count(archive.live)} live sessions' blocks stayed in progress.md.`
        : `${archive.problems.join('; ')} (${count(archive.integrity.archived)} of ${count(archive.stopped)} ended blocks archived).`,
    }

    // File operations: no more per poll at 200 sessions and a full store than at 10 sessions, for the
    // idle receiver poll and for the page poll alike. The idle poll's baseline is 0 file operations, so
    // its allowance is half an operation above 1.25 times the baseline and must be stayed under: a poll that
    // costs one more operation each time is a failure, not slack.
    if (baselineOps === undefined || finalOps === undefined || baselineOps.idle === undefined || finalOps.idle === undefined || baselineOps.page === undefined || finalOps.page === undefined) outcomes.ops = unmeasured('The probe wrote too few lines to measure file operations per poll.')
    else if ((lastBoard?.finished ?? 0) < 1000 && finalOps.finished < 1000) outcomes.ops = unmeasured(`The store held ${count(finalOps.finished)} finished messages, not yet full (1,000).`)
    else {
      const idleLimit = 1.25 * baselineOps.idle + 0.5
      const pageLimit = 1.25 * baselineOps.page + 6
      const isIdleOk = finalOps.idle < idleLimit
      const isPageOk = finalOps.page <= pageLimit
      const line = `An idle receiver poll did ${baselineOps.idle.toFixed(2)} file operations with ${baselineOps.live} sessions and ${finalOps.idle.toFixed(2)} with ${finalOps.live} sessions and ${count(finalOps.finished)} finished messages (it must stay under ${idleLimit.toFixed(2)}, which is 1.25 times the first figure plus half an operation); a page poll did ${baselineOps.page.toFixed(1)} and ${finalOps.page.toFixed(1)} (limit ${pageLimit.toFixed(1)}).`
      outcomes.ops = { ok: isIdleOk && isPageOk, line }
    }

    const slow = report.hooks.filter(one => one.msMost >= one.limit)
    outcomes.hooks = report.hooks.length < HOOKS.length ? unmeasured('The run stopped before the hooks were timed.') : {
      ok: slow.length === 0,
      line: `${report.hooks.map(one => `${one.host} ${one.event} took at most ${one.msMost} ms of ${one.limit}`).join('; ')}, with ${count(lastBoard?.all)} messages in the store and ${count(liveSessions().length)} live receivers.`,
    }

    outcomes.crash = { ok: crash.problems.length === 0 && crash.wasKilled && crash.hasStaleLock && crash.held > 0 && crash.isHeld && crash.isFreshHandedOut === true, line: `${crash.hasStaleLock ? '' : 'The killed hub left no lock naming it. '}${crash.line}` }

    // Anything the run itself recorded (an unexpected answer, a writer or later step that failed, a hook
    // call that exited badly, a tidy that failed) is a failure, even where no other check looks at it.
    outcomes.notes = {
      ok: problemCount === 0,
      line: problemCount === 0 ? 'The soak recorded no error, no failed step and no unexpected answer.' : `The soak recorded ${count(problemCount)} problems${report.notes.length > 0 ? `, the first of them: ${report.notes.slice(0, 3).join('; ')}` : ''}.`,
    }

    const results = []
    for (const [key, title] of Object.entries(TITLES)) {
      const outcome = outcomes[key]
      if (outcome.skipped !== undefined) {
        results.push(isFullRun ? { title, status: 'fail', line: `Not measured in a ${minutes}-minute run: ${outcome.skipped}` } : { title, status: 'skipped', line: outcome.skipped })
        continue
      }
      if (outcome.hold === undefined) { results.push({ title, status: outcome.ok ? 'pass' : 'fail', line: outcome.line }); continue }
      try {
        await knownFailure(outcome.hold, () => { if (!outcome.ok) assert.fail(outcome.line) })
        results.push({ title, status: 'known', line: `${outcome.line} Known problem (#${outcome.hold}).` })
      } catch (error) { results.push({ title, status: 'fail', line: `${error.message} ${outcome.line}` }) }
    }
    report.checks = results
    report.traffic = trafficNow()
  } catch (error) {
    if (control.stop === undefined) {
      report.status = 'failed'
      problem(`The messaging soak stopped on an error: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  } finally {
    clearTimeout(deadline)
    for (const timer of timers) clearTimeout(timer)
  }
  setTimeout(() => giveUp('The teardown took over a minute and was cut short.'), 60000).unref()

  if (report.status === 'running') report.status = control.stop ?? 'finished'
  report.finishedAt = new Date().toISOString()
  save()
  if (server?.isOwned()) {
    let isRefused = false
    try { await fetch(new URL('/api/close', server.url), { method: 'POST', headers: { 'x-board-token': new URL(server.url).searchParams.get('t'), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(control.stop === undefined ? 20000 : 8000) }) } catch (error) { isRefused = error?.cause?.code === 'ECONNREFUSED' }
    for (let waited = 0; waited < 100 && server.isOwned(); waited += 1) await new Promise(done => setTimeout(done, 100))
    if (!isRefused) endHub()
  }
  let closeFailure
  try { await world?.close() } catch (error) {
    closeFailure = error
    problem(`The world did not close cleanly: ${String(error?.errors?.[0]?.message ?? error?.message ?? error).split('\n')[0]}`)
  }
  if (closeFailure !== undefined || saveFailure !== undefined) save()
  for (const check of report.checks) say(`${check.status}: ${check.title} - ${check.line}`)
  if (report.checks.length > 0) say(`messaging soak: ${tallyOf(report.checks)}`)
  if (saveFailure !== undefined) say(`messaging soak: the report could not be written (${saveFailure.code ?? saveFailure.message}).`)
  say(`messaging soak: ${report.status}`)
  return report.status === 'finished' && closeFailure === undefined && saveFailure === undefined && report.checks.length > 0 && !report.checks.some(check => check.status === 'fail') ? 0 : 1
}

const parsed = parseArguments(process.argv.slice(2))
if (parsed.error !== undefined) {
  process.stderr.write(`${parsed.error}\n`)
  process.exitCode = 2
} else {
  const code = await soak(parsed)
  process.stdout.write('', () => process.exit(code))
}

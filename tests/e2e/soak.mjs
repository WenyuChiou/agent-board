import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { arch, homedir, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OUT_DEFAULT, archiveIntegrity, archiveProblems, archiveQuestionIntegrity, archiveQuestionProblems, archiveRefusal, classifySoakChecks, fileOpsPerPoll, levelOutcome, makeRedact, median, parseArguments, peakRss, percentile, questionEvidenceProjection, questionRecoveryOf, tallyOf, writeReport } from './lib/soak-report.mjs'
import { stopTree } from './lib/processes.mjs'

// L6 soak: the terminal board (--watch) and the page server (--serve) run side by side on one
// isolated world while data grows to the scale budget, tasks are archived and the polling goes on.
// It is not a *.test.mjs file, so it never runs per pull request (.github/workflows/soak.yml runs it).
// The hook load phase follows the soak's teardown when minutes <= 35.
//   node tests/e2e/soak.mjs [--minutes 1..45] [--out DIR]

const TITLES = {
  ops: 'L6 soak: 300 polls with new asks keep file operations per poll flat',
  memory: 'L6 soak: server memory stays under 150 MB after 300 polls',
  preserve: 'L6 soak: archived unanswered questions retain identity, age, provenance, source and discoverability',
  survive: 'L6 soak: the page server survives 1,000 polls with no exit',
  watch: 'L6 soak: the terminal board keeps running beside the page',
  level: 'L6 soak: server memory levels off',
}
// The hook load phase's own check, beside the checks hook-load.mjs reports (#395).
const HOOK_LOAD_TITLE = 'L6 hook load: the phase ran to its end and wrote its report'
// The soak ends by its hard deadline, minutes + 5 with the tail inside it. 35 + 5, a minute of teardown
// and at most 16 for the hook load (its 15-minute bound and a minute to end it) stay under the 60-minute job.
const HOOK_LOAD_MAX_MINUTES = 35
const HOOK_LOAD_LIMIT_MS = 15 * 60000
// A check that fails on main because of a known problem passes through knownFailure with its hold id:
// the page server reads every ledger and capture file on every poll (audit P1-3), so its memory
// climbs and its answers slow down to minutes. Survival is held only for falling short of 1,000 polls while
// the file-operation check still fails, since that slowness is what keeps a run short: a page
// server that is gone, answers with an error, drops a connection or leaves a poll unanswered for
// 5 minutes is never held, and neither is a run that reaches 1,000, which says nothing of the bug.
// While the file-operation check fails and is held, the same slowness also explains an archive that
// got no answer in time and too few memory lines after it (see archiveRefusal and levelOutcome).
const HOLDS = { ops: 'hold:serve-poll-file-ops', memory: 'hold:serve-poll-file-ops', survive: 'hold:serve-poll-file-ops' }

const ARCHIVE_SLACK_MS = 120000
// The tail may run this far past the planned time. Its end cuts the poll under way short, so the
// hard deadline still has a minute to spare.
const TAIL_SLACK_MS = 240000
// Growth lasts this share of the planned time, after the warm-up: on a slow server the archive
// takes about a third of a 30-minute run, and the tail after it needs a few polls and memory lines
// while each answer takes a minute or more.
const GROWTH_SHARE = 0.5
const SETTLE_MS = 20000
const SETTLED_LINES = 3
const ENDED_EVERY = 12
const POLL_GAP_MS = 500
const POLL_LIMIT_MS = 15000
const POLL_GIVE_UP_MS = 300000
const CUT_STUCK_MS = 60000
const RESENDS = 2
const SAMPLE_MS = 10000
const PAGE_EVERY = 50
const WARM_POLLS = 20
const TAIL_POLLS = 3
const HOOKS = 10
const TURNS = 30
const QUESTION_TURNS = 20
const MEGABYTE = 1048576

const PROJECTS = ['api-gateway', 'docs-site', 'research-hub', 'billing-core', 'mobile-app', 'infra-tools', 'data-pipeline', 'search-service']
const AGENTS = ['codex', 'antigravity', 'hermes', 'grok', 'gemini', 'cursor', 'opencode', 'muse']
const TOPICS = ['routes', 'cache', 'invoices', 'login', 'exports', 'search index', 'retries', 'metrics', 'templates', 'queue', 'backups', 'rate limits']
const TURN_HOSTS = ['cursor', 'gemini', 'opencode', 'hermes', 'muse']
const CAPTURE = /^progress-questions-source-([a-f0-9]{64})\.json$/
const PROOF = /^progress-questions-(?:retired|consumed)-[a-f0-9]{64}\.json$/

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const soak = async ({ minutes, out }) => {
  const [{ makeWorld }, { LIVE_SESSIONS, BLOCKS, LEDGER_RECORDS }, { block, turn, hook }, { serve }, { knownFailure }, { spawnIsolated }] = await Promise.all([
    import('./lib/world.mjs'), import('./lib/budget.mjs'), import('./lib/writers.mjs'), import('./lib/surfaces.mjs'), import('./lib/known.mjs'), import('./lib/spawn.mjs'),
  ])
  const total = minutes * 60000
  const t0 = performance.now()
  const epoch0 = performance.timeOrigin + t0
  const since = () => performance.now() - t0

  const report = {
    status: 'running', os: `${process.platform} ${release()} ${arch()}`, node: process.version, minutes,
    startedAt: new Date().toISOString(), phases: [], polls: undefined, fileOps: [], memory: { serve: [], watch: [] },
    data: undefined, dataAtGrowthEnd: undefined, archive: undefined, terminalBoard: undefined, checks: [], notes: [],
  }
  const redactions = [['<tmp>', tmpdir()], ['<home>', homedir()], ['<repo>', process.cwd()]]
  // On Windows tmpdir() and homedir() may give the short 8.3 form (RUNNER~1, as on GitHub's
  // runners), while an error message can carry the long one, so that is hidden too.
  for (const [name, path] of [['<tmp>', tmpdir()], ['<home>', homedir()]]) {
    try { if (realpathSync.native(path) !== path) redactions.push([name, realpathSync.native(path)]) } catch {}
  }
  const secrets = []
  // Only the last save decides the exit: one refused rename on Windows mid-run is retried by the next.
  const save = () => {
    try {
      writeReport(out, report, makeRedact(redactions, secrets))
      saveFailure = undefined
    } catch (error) { saveFailure = error }
  }
  let saveFailure
  const say = text => process.stdout.write(`${makeRedact(redactions, secrets)(text)}\n`)
  const problem = text => {
    if (report.notes.length < 12 && !report.notes.includes(text)) report.notes.push(text)
  }

  // Stopping: a signal, or the hard deadline of minutes + 5. Every wait wakes at once.
  const control = { stop: undefined }
  const stopper = new AbortController()
  const wakers = new Set()
  const sleep = ms => new Promise(done => {
    const wake = () => { clearTimeout(timer); wakers.delete(wake); done() }
    const timer = setTimeout(wake, ms)
    wakers.add(wake)
  })
  const isRunning = () => control.stop === undefined
  let world, server, watch, stopping
  // A busy page server cannot answer a close request, so the last resort ends both board processes.
  // The page server is a detached process: it is ended only while the world's address file still
  // names its pid and address, so a pid the system gave to another program is never touched.
  const endBoards = () => {
    try { if (server?.isOwned()) process.kill(server.pid) } catch {}
    try { watch?.child.kill() } catch {}
  }
  let isGivingUp = false
  let isHookLoadRunning = false
  const giveUp = async note => {
    if (isGivingUp) return
    isGivingUp = true
    const stopDeadline = Date.now() + 25000
    problem(note)
    save()
    endBoards()
    if (stopping !== undefined) await Promise.race([stopping, new Promise(done => setTimeout(done, Math.max(0, stopDeadline - Date.now())))])
    await Promise.race([world?.close().catch(() => {}), new Promise(done => setTimeout(done, 15000))])
    process.exit(1)
  }
  const stopNow = status => {
    if (control.stop !== undefined) return
    control.stop = status
    // A cancelled CI job kills the process about 10 s after the signal: the report says so now.
    report.status = status
    save()
    stopper.abort()
    for (const wake of [...wakers]) wake()
    // The run should stop by itself within moments; if it does not, leave with what there is.
    const stopSeconds = isHookLoadRunning ? 90 : 30
    setTimeout(() => giveUp(`The soak did not stop in ${stopSeconds} seconds and was closed from outside.`), stopSeconds * 1000).unref()
  }
  process.on('SIGINT', () => stopNow('interrupted'))
  process.on('SIGTERM', () => stopNow('interrupted'))
  // An error nothing caught still leaves a report and no board process behind.
  const crashed = error => {
    report.status = 'failed'
    giveUp(`The soak stopped on an error nothing caught: ${String(error?.message ?? error).split('\n')[0]}`)
  }
  process.on('uncaughtException', crashed)
  process.on('unhandledRejection', crashed)
  process.on('exit', endBoards)
  const deadline = setTimeout(() => stopNow('timed out'), total + 5 * 60000)

  let phase = 'start'
  const setPhase = name => {
    phase = name
    report.phases.push({ name, startedAt: new Date().toISOString() })
    say(`soak: ${name} began after ${Math.round(since() / 1000)} s`)
    save()
  }

  const polls = []
  // The poll the end of the tail cut short, kept apart from the polls that got an answer or failed.
  let cutPoll
  const samples = { serve: [], watch: [] }
  const state = { archiveStartAt: undefined, archiveEndPolls: undefined, archiveEndAt: undefined, archivedSessions: undefined, heldBefore: undefined, watchFramesAtArchive: undefined, growthEndAt: undefined }
  // The polls sent after the archive was done: one sent before its last request does not count.
  const tailPolls = () => state.archiveEndAt === undefined ? [] : polls.filter(one => one.start >= state.archiveEndAt)
  let sampler
  let isLoopDone = false
  let probeDir, token, sw

  save()
  // A folder the report cannot be written to is found now, not after the whole run.
  if (saveFailure !== undefined) {
    clearTimeout(deadline)
    say(`soak: the report cannot be written to ${out} (${saveFailure.code ?? saveFailure.message}).`)
    return 1
  }

  // The hook load has its own world and process tree, after this world's teardown. A stop of the
  // soak asks it to stop too, while its own bound still leaves time to close and count leftovers.
  const hookLoadPhase = async () => {
    if (stopper.signal.aborted) return []
    // Absolute: the child's working folder is its world's, which is removed afterwards.
    const folder = resolve(out, 'hook-load')
    const file = join(folder, 'hook-load.json')
    try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const startedAt = Date.now()
    say(`soak: hook-load phase began after ${Math.round(since() / 1000)} s`)
    isHookLoadRunning = true
    let child, deadline, killTimer, phaseWorld
    let roots = []
    let isFinished = false
    const stop = () => {
      child?.stdin.end('stop\n')
      if (killTimer === undefined || stopper.signal.aborted) {
        clearTimeout(killTimer)
        killTimer = setTimeout(() => { void stopPhase() }, stopper.signal.aborted ? 30000 : 60000)
      }
    }
    const stopPhase = () => {
      if (stopping === undefined) stopping = (async () => {
        try {
          // Recheck after listing: a child that exited meanwhile may already have had its pid reused.
          const stopped = await stopTree({ spawnIsolated, makeWorld, rootPid: child.pid, isRootAlive: () => child.exitCode === null && child.signalCode === null, roots, timeoutMs: stopper.signal.aborted ? 50000 : 60000 })
          report.hookLoad = { ...report.hookLoad, stopped }
          const names = Object.entries(stopped.names).map(([name, count]) => `${name} ${count}`).join(', ') || 'none'
          say(stopped.remaining === undefined
            ? `soak: ${stopped.stopped} processes of the hook-load phase were sent a kill (${names}); whether any remain is unknown: ${stopped.unchecked}.`
            : `soak: ${stopped.stopped} processes of the hook-load phase were stopped (${names}); ${stopped.remaining} remain.`)
        } catch (error) {
          report.notes.push(`The hook-load phase's process tree could not be stopped and counted: ${String(error?.message ?? error).split('\n')[0]}`)
          try { child.kill('SIGKILL') } catch {}
        }
        save()
      })()
      return stopping
    }
    try {
      // The phase starts as every e2e child does, inside a world of its own (lib/spawn.mjs), and makes
      // its worlds in that world's temp folder. It keeps the world's folders, not its clock and
      // clipboard preloads, and it gets CI or AGENT_BOARD_HEAVY_TESTS, which choose its size.
      phaseWorld = makeWorld()
      roots = [phaseWorld.root, realpathSync.native(phaseWorld.root)]
      const env = Object.fromEntries(Object.entries(phaseWorld.env).filter(([name]) => name !== 'NODE_OPTIONS' && !name.startsWith('E2E_')))
      for (const name of ['CI', 'AGENT_BOARD_HEAVY_TESTS']) if (process.env[name] !== undefined) env[name] = process.env[name]
      child = spawnIsolated(process.execPath, [fileURLToPath(new URL('./hook-load.mjs', import.meta.url)), '--out', folder, '--stop-on-stdin'], { env, cwd: phaseWorld.root, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.on('error', () => {})
      stopper.signal.addEventListener('abort', stop)
      let isTimedOut = false
      deadline = setTimeout(() => {
        isTimedOut = true
        stop()
      }, HOOK_LOAD_LIMIT_MS)
      let carry = '', said = ''
      child.stdout.setEncoding('utf8').on('data', chunk => {
        const lines = (carry + chunk).split('\n')
        carry = lines.pop()
        for (const line of lines) if (line.trim() !== '') say(`hook-load: ${line.trim().replace(/^hook load: /, '')}`)
      })
      child.stderr.setEncoding('utf8').on('data', chunk => { said = (said + chunk).slice(-400) })
      const { code, signal } = await new Promise(done => {
        child.once('close', (code, signal) => done({ code, signal }))
        child.once('error', error => { said = error.message; done({ code: null, signal: null }) })
      })
      const exit = typeof code === 'number' ? `exit ${code}` : signal ? `stopped by ${signal}` : 'no exit code'
      if (stopping !== undefined) await stopping
      let found
      try { found = JSON.parse(readFileSync(file, 'utf8')) } catch {}
      if (!Array.isArray(found?.checks) || !(Date.parse(found.startedAt) >= startedAt)) return [{ title: HOOK_LOAD_TITLE, status: 'fail', line: isTimedOut ? `The phase did not exit within ${HOOK_LOAD_LIMIT_MS / 60000} minutes and was stopped (${exit}).` : `The phase left no current report (${exit}).${said ? ` It said: ${said.trim().split('\n').at(-1)}` : ''}` }]
      report.hookLoad = { ...report.hookLoad, mode: found.mode, sessions: found.sessions, seconds: found.seconds, status: found.status, stats: found.stats, notes: found.notes }
      isFinished = !isTimedOut && found.status === 'finished' && code === 0
      return [...found.checks, { title: HOOK_LOAD_TITLE, status: isFinished ? 'pass' : 'fail', line: isTimedOut ? `The phase did not exit within ${HOOK_LOAD_LIMIT_MS / 60000} minutes and was stopped (${exit}).` : `The ${found.mode} run, ${found.sessions} sessions for ${found.seconds} s, ${found.status} (${exit}).` }]
    } finally {
      clearTimeout(deadline)
      clearTimeout(killTimer)
      stopper.signal.removeEventListener('abort', stop)
      // The world is removed only once the child is gone: on Windows its working folder is inside it.
      if (child?.pid !== undefined) {
        const isAlive = child.exitCode === null && child.signalCode === null
        const closed = isAlive ? new Promise(done => child.once('close', done)) : undefined
        if (isAlive || !isFinished) await stopPhase()
        if (isAlive) await Promise.race([closed, new Promise(done => setTimeout(done, 5000))])
      }
      isHookLoadRunning = false
      try { await phaseWorld?.close() } catch (error) { say(`soak: the hook-load phase's world did not close cleanly: ${String(error?.errors?.[0]?.message ?? error?.message ?? error).split('\n')[0]}`) }
    }
  }
  try {
    world = makeWorld()
    redactions.push(['<world>', world.root], ['<world>', realpathSync.native(world.root)])
    probeDir = join(world.root, 'probe')
    mkdirSync(probeDir)
    world.env.E2E_SOAK_PROBE_DIR = probeDir
    world.env.NODE_OPTIONS += ` --import=${pathToFileURL(fileURLToPath(new URL('./lib/soak-probe.mjs', import.meta.url))).href}`

    // Writers go through a rename, as a host's reporter does, so a board read never meets half a file.
    sw = Object.create(world, {
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

    // The page server stays up for the whole soak (the default kill check waits 20 s).
    server = await serve.start(world, [], { lifetimeMs: total + 6 * 60000, idleMinutes: minutes + 10 })
    token = new URL(server.url).searchParams.get('t')
    secrets.push(server.url, new URL(server.url).search, token)

    // The terminal board beside it: the same tty preload as terminal.watch, but only counts of what
    // it prints are kept, and its pipes are always drained.
    const startWatch = () => {
      const preload = world.write('tty.mjs', `Object.defineProperty(process.stdin, 'isTTY', { value: true })\nprocess.stdin.setRawMode = () => {}\n`)
      const child = spawnIsolated(process.execPath, ['--import', pathToFileURL(preload).href, world.script, '--watch'], { env: world.env, cwd: world.root, stdio: ['pipe', 'pipe', 'pipe'] })
      const clear = '\x1b[2J\x1b[H'
      const board = { child, frames: 0, headed: 0, lastAt: 0, errors: '' }
      let carry = ''
      child.stdout.setEncoding('utf8').on('data', chunk => {
        const text = carry + chunk
        carry = text.slice(-(clear.length - 1))
        let at = text.indexOf(clear)
        while (at !== -1) {
          board.frames += 1
          board.lastAt = since()
          if (text.slice(at, at + 400).includes('Progress')) board.headed += 1
          at = text.indexOf(clear, at + clear.length)
        }
      })
      child.stderr.setEncoding('utf8').on('data', chunk => { board.errors = (board.errors + chunk).slice(-400) })
      child.on('error', error => { board.errors = String(error.message) })
      const closed = new Promise(done => child.once('close', done))
      let isStopped = false
      world.cleanups.push(async () => {
        if (isStopped) return
        isStopped = true
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill()
          await closed
        } finally { child.stdin.destroy() }
      })
      return board
    }
    watch = startWatch()

    // What the probe wrote, as samples in soak time.
    const readProbe = () => {
      let names = []
      try { names = readdirSync(probeDir) } catch { return }
      const next = { serve: [], watch: [] }
      for (const name of names) {
        const role = name.startsWith('serve-') ? 'serve' : name.startsWith('watch-') ? 'watch' : undefined
        if (role === undefined) continue
        let text = ''
        try { text = readFileSync(join(probeDir, name), 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          if (line === '') continue
          try {
            const row = JSON.parse(line)
            if (row.pid !== (role === 'serve' ? server.pid : watch.child.pid)) continue
            next[role].push({ t: row.at - epoch0, rss: row.rss, heapUsed: row.heapUsed, ops: Object.values(row.ops).reduce((sum, value) => sum + value, 0), requests: row.requests })
          } catch {}
        }
      }
      for (const role of ['serve', 'watch']) samples[role] = next[role].sort((a, b) => a.t - b.t)
    }

    let last = {}
    const dataNow = () => {
      let progress = ''
      let names = []
      try { progress = readFileSync(world.path, 'utf8') } catch {}
      try { names = readdirSync(world.claudeDir) } catch {}
      const blocks = [...progress.matchAll(/^<!-- auto session=([a-f0-9]+) [^\n]*?state=(\w+)/gm)]
      const found = { progressBytes: Buffer.byteLength(progress), captureFiles: names.filter(name => CAPTURE.test(name)).length, proofFiles: names.filter(name => PROOF.test(name)).length, blocks: blocks.length, liveSessions: blocks.filter(one => one[2] === 'working' || one[2] === 'waiting').length }
      try {
        const text = readFileSync(join(world.claudeDir, 'progress-questions.json'), 'utf8')
        found.ledgerBytes = Buffer.byteLength(text)
        found.questionRecords = JSON.parse(text).records.length
      } catch {}
      last = { ...last, ...found }
      return { ...last }
    }

    // The ledger records and capture files of each task, plus the same capture projection the board
    // uses to recover questions whose mutable ledger entry is stale or missing.
    const sessionOf = scope => { try { return JSON.parse(scope)[2] } catch { return '' } }
    const holdings = () => {
      const bySession = new Map()
      const add = (session, key) => {
        const one = bySession.get(session) ?? { records: 0, captures: 0 }
        one[key] += 1
        bySession.set(session, one)
      }
      const found = { bySession, ledgerTotal: 0, captureTotal: 0, questions: [], error: undefined }
      let ledgerText
      const captures = []
      try { ledgerText = readFileSync(join(world.claudeDir, 'progress-questions.json'), 'utf8') } catch (error) { found.error = error.code ?? error.message }
      let names = []
      try { names = readdirSync(world.claudeDir).filter(one => CAPTURE.test(one)) } catch (error) { found.error ??= error.code ?? error.message }
      for (const name of names) {
        try {
          const text = readFileSync(join(world.claudeDir, name), 'utf8')
          const hash = name.match(CAPTURE)?.[1]
          if (hash === undefined) throw new Error(`${name} has no question capture hash`)
          captures.push({ hash, text })
        } catch (error) { found.error ??= error.code ?? error.message }
      }
      if (found.error === undefined && ledgerText !== undefined) {
        const evidence = questionEvidenceProjection({ ledgerText, captures })
        if (evidence.error !== undefined) found.error = evidence.error
        else {
          found.ledgerTotal = evidence.ledger.length
          found.captureTotal = evidence.captures.length
          found.questions = evidence.questions
          for (const record of evidence.ledger) add(sessionOf(record.scope), 'records')
          for (const capture of evidence.captures) add(sessionOf(capture.record.scope), 'captures')
        }
      }
      return found
    }
    const sumOf = (held, sessions, key) => [...sessions].reduce((sum, session) => sum + (held.bySession.get(session)?.[key] ?? 0), 0)

    const summarize = () => {
      const answered = polls.filter(one => !one.failed)
      const latencies = answered.map(one => one.ms)
      report.polls = {
        count: polls.length, failed: polls.filter(one => one.failed).length, slow: polls.filter(one => one.slow).length + (cutPoll?.isSlow ? 1 : 0), badStatus: answered.filter(one => one.status !== 200).length,
        badBy: answered.filter(one => one.status !== 200).reduce((counts, one) => ({ ...counts, [one.status]: (counts[one.status] ?? 0) + 1 }), {}),
        retried: polls.filter(one => one.isRetried).length,
        cut: cutPoll === undefined ? undefined : { seconds: Math.round(cutPoll.ms / 1000), isSlow: cutPoll.isSlow, phase: cutPoll.phase },
        failedBy: polls.filter(one => one.failed).reduce((counts, one) => ({ ...counts, [one.cause]: (counts[one.cause] ?? 0) + 1 }), {}),
        median: median(latencies), p95: percentile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : undefined,
        firstSize: answered[0]?.size, lastSize: answered.at(-1)?.size,
      }
      report.memory = {
        serve: samples.serve.map(one => ({ seconds: Math.round(one.t / 1000), bytes: one.rss })),
        watch: samples.watch.map(one => ({ seconds: Math.round(one.t / 1000), bytes: one.rss })),
      }
      report.terminalBoard = { frames: watch.frames, framesAfterArchive: state.watchFramesAtArchive === undefined ? undefined : watch.frames - state.watchFramesAtArchive, alive: watch.child.exitCode === null && watch.child.signalCode === null }
    }
    const tick = () => {
      readProbe()
      report.data = dataNow()
      summarize()
      save()
    }
    let ticks = 0
    sampler = setInterval(() => {
      tick()
      if (++ticks % 6 === 0) say(`soak: ${phase}, ${Math.round(since() / 1000)} s, ${polls.length} polls`)
    }, SAMPLE_MS)

    // The polls: the page's own request, back to back with a gap after each answer. Like the page,
    // which never gives up on a poll, a poll waits for its answer: one dropped early would leave the
    // server working on it while the next one arrives, a pile-up the page never makes. An answer
    // later than 15 s still counts as a slow one; a poll fails when the connection fails or no answer
    // comes in 5 minutes.
    const board = new URL('/api/board', server.url)
    const headers = { 'x-board-token': token }
    // The end of the tail cuts the poll under way short, so a slow answer cannot hold the run past it.
    const loopEnd = new AbortController()
    const pollSignal = () => AbortSignal.any([AbortSignal.timeout(POLL_GIVE_UP_MS), stopper.signal, loopEnd.signal])
    // Why a request got no answer, in plain words for the report.
    const causeOf = error => {
      const code = error?.cause?.code ?? error?.code
      // undici's own header and body timers are 300 s too, and may run out first.
      if (error?.name === 'TimeoutError' || ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'no answer in 5 minutes'
      if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'].includes(code)) return 'connection closed'
      if (code === 'ECONNREFUSED') return 'connection refused'
      return 'other error'
    }
    // Browsers send a request again when a kept-alive connection closes before any answer comes back,
    // which happens when a busy server times idle connections out just as the next request goes out.
    // The soak allows two resends because it holds at most two connections (the polls and the
    // archive's requests), so the third try is on a fresh one. A body cut off after the answer began
    // is never sent again.
    const getOnce = async (url, init) => {
      let isRetried = false
      for (let attempt = 1; ; attempt += 1) {
        let response
        try { response = await fetch(url, { ...init, signal: pollSignal() }) } catch (error) {
          const cause = causeOf(error)
          if (attempt <= RESENDS && cause === 'connection closed' && !stopper.signal.aborted && !loopEnd.signal.aborted) { isRetried = true; continue }
          return { failed: true, cause, isRetried }
        }
        try { return { failed: false, status: response.status, size: (await response.arrayBuffer()).byteLength, isRetried } } catch (error) { return { failed: true, cause: causeOf(error), isRetried } }
      }
    }
    const pollLoop = async () => {
      while (!isLoopDone) {
        const number = polls.length + 1
        const during = phase
        const start = since()
        const got = await getOnce(board, { headers })
        const status = got.status ?? 0
        const size = got.size ?? 0
        let { failed, cause, isRetried } = got
        const ms = Math.round(since() - start)
        if (!failed && number % PAGE_EVERY === 0) {
          const page = await getOnce(server.url, {})
          if (page.failed) { failed = true; cause = `${page.cause}, page` }
          isRetried = isRetried || page.isRetried
        }
        // A poll the stop or the end of the tail cut short got no answer only because the soak stopped
        // waiting, so it is not a failed poll. The one the tail's end cut is kept apart, and counts as
        // slow once it has waited longer than POLL_LIMIT_MS; one answered just before the end is a poll.
        if (failed && (stopper.signal.aborted || loopEnd.signal.aborted)) {
          if (!stopper.signal.aborted) cutPoll = { start, ms: Math.round(since() - start), isSlow: since() - start > POLL_LIMIT_MS, phase: during }
          break
        }
        polls.push({ number, start, end: since(), ms, status, size, failed, cause: failed ? cause : undefined, isRetried, slow: !failed && ms > POLL_LIMIT_MS, phase: during })
        if (!isLoopDone) await sleep(POLL_GAP_MS)
      }
    }
    const waitPolls = async (more, limitMs = 20000) => {
      const goal = polls.length + more
      const until = since() + limitMs
      while (isRunning() && polls.length < goal && since() < until) await sleep(100)
    }
    // The archive's requests wait for their answer as a poll does, since one given up early is still
    // carried out by the server after the soak has looked; but never past the time the archive may
    // take (the planned time and ARCHIVE_SLACK_MS), so the tail still gets its polls.
    const archiveWait = () => Math.max(1000, Math.floor(Math.min(POLL_GIVE_UP_MS, total + ARCHIVE_SLACK_MS - since())))
    // A request that gets no answer (a busy page server, or the soak stopping) is status 0, not a crash.
    // Its cause tells a wait that ran out ('timeout') from a refused or lost connection. A kept-alive
    // connection that closes before any answer is the same race the polls resend for, so the
    // request is sent once more, and counted: the server never had it. Once an answer has begun
    // nothing is sent again, and an answer cut off keeps its status.
    const CALL_CAUSES = { 'no answer in 5 minutes': 'timeout', 'connection closed': 'closed', 'connection refused': 'refused' }
    let resent = 0
    const call = async (path, body) => {
      const start = since()
      const failed = (error, words, status = 0) => {
        if (isRunning()) problem(`A request to the page for ${path} ${words} after ${Math.round((since() - start) / 1000)} s: ${String(error?.message ?? error).split(/\r?\n/)[0]}`)
        return { status, json: {}, cause: CALL_CAUSES[causeOf(error)] ?? 'other' }
      }
      let response
      for (let attempt = 1; response === undefined; attempt += 1) {
        try {
          response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(archiveWait()), stopper.signal]) })
        } catch (error) {
          if (CALL_CAUSES[causeOf(error)] === 'closed' && attempt === 1 && isRunning()) { resent += 1; continue }
          return failed(error, 'got no answer')
        }
      }
      let text
      try { text = await response.text() } catch (error) { return failed(error, 'had its answer cut off', response.status) }
      let json = {}
      try { json = JSON.parse(text) } catch {}
      return { status: response.status, json }
    }
    // A 408 is the server's own wait running out, the same as no answer in time.
    const refusalOf = answer => answer.status === 408 ? { cause: 'timeout', count: 1 } : answer.status === 0 ? { cause: answer.cause ?? 'other', count: 1 } : { cause: 'status', status: answer.status, count: 1 }

    // The data. 290 blocks come from block(), 10 from the Codex hook; 200 of the block() ones are
    // finished during growth, so growth ends with 100 live sessions and 300 blocks; the questions
    // add up to the ledger budget together with the question turns from the inbox.
    const made = BLOCKS - HOOKS
    const finished = made - (LIVE_SESSIONS - HOOKS)
    const blockQuestions = LEDGER_RECORDS - QUESTION_TURNS
    const topicOf = number => TOPICS[number % TOPICS.length]
    const questionsOf = number => Array.from({ length: Math.floor(blockQuestions * (number + 1) / made) - Math.floor(blockQuestions * number / made) }, (_, at) => `Should the ${topicOf(number)} keep option ${at + 1} for task ${number + 1}, OK?`)
    const specOf = (number, kind) => {
      const questions = questionsOf(number)
      const answered = kind === 'done'
      return {
        project: PROJECTS[number % PROJECTS.length], agent: AGENTS[Math.floor(number / PROJECTS.length) % AGENTS.length],
        session: (0xd0000000 + number).toString(16), state: kind === 'open' ? 'waiting' : kind,
        title: `Soak task ${number + 1}: ${topicOf(number)}`,
        steps: ['- [x] Read the brief', ...questions.map(text => `- [${answered ? 'x' : '?'}] ${text}`), `- [${answered ? 'x' : ' '}] Wrap up the task`],
      }
    }
    const createdSessions = new Set()

    const growth = async (start, span) => {
      const events = []
      for (let number = 0; number < made; number += 1) {
        const at = span * (0.01 + 0.89 * number / made)
        events.push({ at, run: () => { block(sw, specOf(number, 'open')); createdSessions.add(specOf(number, 'open').session) } })
        if (number < finished) events.push({ at: at + 0.1 * span, run: () => block(sw, specOf(number, 'done')) })
      }
      for (let at = 0; at < TURNS; at += 1) {
        const isQuestion = at < QUESTION_TURNS
        const host = TURN_HOSTS[at % TURN_HOSTS.length]
        const subject = topicOf(at + 3)
        events.push({ at: span * (0.02 + 0.88 * at / TURNS), run: () => turn(sw, host, { session: `soak-${host}-${at}`, project: PROJECTS[at % PROJECTS.length], text: isQuestion ? `Should I rename the ${subject} module, OK?` : `Finished the ${subject} checks.` }) })
      }
      for (let at = 0; at < HOOKS; at += 1) {
        events.push({ at: span * (0.05 + 0.8 * at / HOOKS), run: async () => {
          const result = await hook(world, 'codex', 'UserPromptSubmit', { session_id: `soak-codex-${at}`, prompt: `Soak codex task ${at + 1}: ${topicOf(at)}`, cwd: join(world.root, PROJECTS[at % PROJECTS.length]) })
          if (result.status !== 0) problem(`A Codex hook call exited with ${result.status}.`)
        } })
      }
      events.sort((a, b) => a.at - b.at)
      for (const event of events) {
        const early = start + event.at - since()
        if (early > 0) await sleep(early)
        if (!isRunning()) return
        try { await event.run() } catch (error) { problem(`A writer failed: ${String(error.message).split('\n')[0]}`) }
      }
      const rest = start + span - since()
      if (rest > 0) await sleep(rest)
    }

    // The archive: the page's own requests. "Archive now" (POST /api/tidy) moves every finished task
    // at once; a stopped task that still asks something is archived from its card (POST /api/act),
    // the one path that keeps its questions. Terminal --keys would start one process per task, and
    // --tidy skips a task with an open question and never touches the question files.
    const archive = async () => {
      const live = Array.from({ length: made - finished }, (_, at) => finished + at)
      const ended = live.filter((_, at) => at % ENDED_EVERY === 0)
      for (const number of live) {
        try { block(sw, specOf(number, ended.includes(number) ? 'ended' : 'done')) } catch (error) { problem(`A writer failed: ${String(error.message).split('\n')[0]}`) }
      }
      await waitPolls(3)
      // What the tasks hold just before the archive, so preservation is compared with actual evidence.
      state.heldBefore = holdings()
      const sessionsIn = () => new Set([...readFileSync(world.path, 'utf8').matchAll(/^<!-- auto session=([a-f0-9]+) /gm)].map(one => one[1]))
      // The blocks the archive is not to touch (the Codex hook's), to tell later that none was lost.
      const others = [...sessionsIn()].filter(session => !createdSessions.has(session))
      const stoppedSessions = new Set(ended.map(number => specOf(number, 'ended').session))
      const refusals = []
      const answered = new Set()
      const unpressed = new Set()
      const tidy = await call('/api/tidy', {})
      if (tidy.status === 200) for (const session of createdSessions) { if (!stoppedSessions.has(session)) answered.add(session) }
      else {
        refusals.push(refusalOf(tidy))
        problem(`Archive now answered ${tidy.status}.`)
      }
      // One look at the board gives every stopped card's key and fingerprint; none of them changes meanwhile.
      let look = { status: 0, json: {} }
      for (let attempt = 1; attempt <= 3 && isRunning() && look.json.model === undefined; attempt += 1) look = await call('/api/board')
      const rows = look.json.model === undefined ? [] : [...look.json.model.groups.flatMap(group => group.rows), ...look.json.model.stopped, ...look.json.model.idle]
      for (const [at, number] of ended.entries()) {
        if (!isRunning()) break
        // The stopped tasks not reached count as refused: the archive did not finish.
        if (since() > total + ARCHIVE_SLACK_MS) {
          problem('The archive of stopped tasks was cut short because the planned time was long over.')
          refusals.push({ cause: 'cut', count: ended.length - at })
          for (const left of ended.slice(at)) unpressed.add(specOf(left, 'ended').session)
          break
        }
        const { title, session } = specOf(number, 'ended')
        const row = rows.find(one => one.title === title && one.canArchive)
        // With no board to read, the card's button could not be pressed: its cause is the board's
        // (a board answered 200 that could not be read is its own cause).
        if (row === undefined) {
          const isNoBoard = look.json.model === undefined
          if (isNoBoard) unpressed.add(session)
          refusals.push(!isNoBoard ? { cause: 'button', count: 1 } : look.status === 200 ? { cause: 'unreadable', count: 1 } : refusalOf(look))
          problem(!isNoBoard ? 'A stopped task with a question had no Archive button.' : look.status === 200 ? 'The board for the stopped tasks could not be read.' : 'The board for the stopped tasks got no answer.')
          continue
        }
        const answer = await call('/api/act', { key: row.key, type: 'archive', text: '', session: '', asked: '', fp: row.fp })
        if (answer.status === 200) answered.add(session)
        else {
          refusals.push(refusalOf(answer))
          problem(`Archiving a stopped task with a question answered ${answer.status}.`)
        }
      }
      await waitPolls(2)
      const present = sessionsIn()
      const tried = [...createdSessions]
      state.archivedSessions = new Set(tried.filter(session => !present.has(session)))
      // A task that left progress.md is archived only when its title is in a month archive file.
      const folder = dirname(world.path)
      const archivedTitles = new Set(readdirSync(folder).filter(name => /-archive-\d{4}-\d{2}\.md$/.test(name))
        .flatMap(name => readFileSync(join(folder, name), 'utf8').split(/\r?\n/).filter(line => line.startsWith('### ')).map(line => line.slice(4))))
      const planned = Array.from({ length: made }, (_, number) => ({ session: specOf(number, 'open').session, title: specOf(number, 'open').title, isStopped: stoppedSessions.has(specOf(number, 'open').session) }))
      const integrity = archiveIntegrity({ planned, answered, unpressed, present, archivedTitles, others })
      const refused = refusals.reduce((sum, one) => sum + one.count, 0)
      report.archive = { path: 'the page\'s own requests: Archive now for finished tasks, and the card\'s Archive button for stopped tasks that still ask something.', tried: tried.length, gone: state.archivedSessions.size, refused, refusals, integrity, resent }
    }

    const conductor = async () => {
      setPhase('warm-up')
      while (isRunning() && !(since() >= 0.05 * total && polls.length >= WARM_POLLS)) await sleep(200)
      if (!isRunning()) return
      setPhase('growth')
      await growth(since(), GROWTH_SHARE * total)
      if (!isRunning()) return
      await waitPolls(3)
      state.growthEndAt = since()
      readProbe()
      report.dataAtGrowthEnd = dataNow()
      setPhase('archive')
      state.archiveStartAt = since()
      await archive()
      if (!isRunning()) return
      state.archiveEndPolls = polls.length
      state.archiveEndAt = since()
      state.watchFramesAtArchive = watch.frames
      setPhase('tail')
      // The tail lasts the planned time, and then until the preservation check has its polls and the
      // levels-off check its memory lines, but never past the slack.
      const settledLines = () => samples.serve.filter(one => one.t >= state.archiveEndAt + SETTLE_MS).length
      const isTailDone = () => since() >= total + TAIL_SLACK_MS || (since() >= total && tailPolls().length >= TAIL_POLLS && settledLines() >= SETTLED_LINES)
      while (isRunning() && !isTailDone()) await sleep(250)
    }

    const polling = pollLoop()
    try { await conductor() } finally {
      isLoopDone = true
      loopEnd.abort()
      for (const wake of [...wakers]) wake()
    }
    await polling
    const endAt = since()

    // Last look, before anything is stopped.
    readProbe()
    report.data = dataNow()
    summarize()
    const isServerAlive = server.isOwned()
    const board300 = polls[299]
    const answered = polls.filter(one => !one.failed)
    const growthPolls = polls.filter(one => one.phase === 'growth')
    const serveSamples = samples.serve
    const megabytes = bytes => (bytes / MEGABYTE).toFixed(0)

    const windowOf = (name, list) => {
      const found = list.length === 0 ? undefined : fileOpsPerPoll(serveSamples, list[0].start, list.at(-1).end)
      report.fileOps.push({ name, perPoll: found?.perPoll })
      return found
    }
    const first50 = windowOf('first 50 growth polls', growthPolls.slice(0, 50))
    const hasReached300 = growthPolls.length >= 300
    const lastLabel = hasReached300 ? 'growth polls 251 to 300' : 'the last 50 growth polls'
    // A slow run may not reach 300 growth polls; from 150 on, the last 50 are far enough from the first 50 to compare.
    const lastList = hasReached300 ? growthPolls.slice(250, 300) : growthPolls.length >= 150 ? growthPolls.slice(-50) : []
    const last50 = windowOf(lastLabel, lastList)
    windowOf('warm-up', polls.filter(one => one.phase === 'warm-up'))
    windowOf('archive phase', polls.filter(one => one.phase === 'archive'))
    windowOf('tail', polls.filter(one => one.phase === 'tail'))

    // Each check says skipped, or gives a verdict and one line of numbers.
    const outcomes = {}
    // Without the probe's lines nothing is known of file operations or memory: the soak's own
    // instrument failed, which no hold explains.
    const isProbeSilent = serveSamples.length === 0
    const silentProbe = { ok: false, isUnheld: true, line: 'The probe wrote nothing for the page server, so this could not be measured.' }
    if (isProbeSilent) outcomes.ops = silentProbe
    else if (first50 === undefined || last50 === undefined) outcomes.ops = { skipped: `Too short to compare: ${growthPolls.length} growth polls, or no probe lines for them.` }
    else {
      const limit = 1.25 * first50.perPoll + 6
      outcomes.ops = { ok: last50.perPoll <= limit, line: `The page server did ${first50.perPoll.toFixed(1)} file operations per poll over the first 50 growth polls and ${last50.perPoll.toFixed(1)} over ${lastLabel}; the limit is ${limit.toFixed(1)}.` }
    }
    const afterPeak = board300 === undefined ? undefined : peakRss(serveSamples, board300.end, Infinity)
    if (isProbeSilent) outcomes.memory = silentProbe
    else if (board300 === undefined) outcomes.memory = { skipped: `Only ${polls.length} polls were reached, 300 are needed.` }
    else if (afterPeak === undefined) outcomes.memory = { skipped: 'The page server wrote no memory line after poll 300.' }
    else outcomes.memory = { ok: afterPeak < 150 * MEGABYTE, line: `The page server's highest memory after poll 300 was ${megabytes(afterPeak)} MB (limit 150 MB).` }
    // The file-operation check fails and is held: the known slowness that can explain a short run,
    // an archive with no answer in time and too few memory lines after it.
    const isOpsHeld = outcomes.ops.ok === false && outcomes.ops.isUnheld !== true

    if (state.archivedSessions === undefined || state.archiveEndPolls === undefined) outcomes.preserve = { skipped: 'The run ended before the archive phase was done.' }
    else {
      const archived = state.archivedSessions
      // A retained source can stay in the main questions or move to a shelf. Preserve that existing
      // placement and ask every actual page surface for membership instead of trusting a flag.
      let recovery = { status: 0, checked: false, questionIds: [], error: undefined }
      try {
        const response = await server.get('/api/board')
        recovery = questionRecoveryOf(response.status, response.status === 200 ? response.json().model : undefined)
      } catch (error) {
        recovery.error = `The page questions could not be read: ${String(error?.message ?? error).split('\n')[0]}`
      }
      report.archive.recovery = recovery
      const held = holdings()
      const records = sumOf(held, archived, 'records')
      const captures = sumOf(held, archived, 'captures')
      const recordsBefore = sumOf(state.heldBefore, archived, 'records')
      const capturesBefore = sumOf(state.heldBefore, archived, 'captures')
      const afterArchive = tailPolls().length
      // The server may still be taking in questions when the archive starts, so the count at the
      // end can be higher than the one before it.
      const counted = `${archived.size} tasks were archived; they had ${recordsBefore} ledger records and ${capturesBefore} capture files just before the archive and ${records} and ${captures} at the end (${held.ledgerTotal} records and ${held.captureTotal} capture files in all)`
      const unread = state.heldBefore.error !== undefined ? `just before the archive (${state.heldBefore.error})` : held.error !== undefined ? `at the end (${held.error})` : undefined
      // Unread evidence can hide a lost identity, so it never counts as successful preservation.
      if (unread !== undefined) outcomes.preserve = { ok: false, isUnheld: true, line: `Question recovery evidence could not be read ${unread}.` }
      else if (!recovery.checked) outcomes.preserve = { ok: false, isUnheld: true, line: recovery.error }
      // A refused or unanswered archive request leaves stopped tasks with questions out, the one
      // path that keeps them, so preservation cannot be judged: it fails, or is the known slowness.
      // Work the archive lost or did not move fails whatever its requests answered.
      else if (archiveProblems(report.archive.integrity).length > 0) outcomes.preserve = { ok: false, isUnheld: true, line: `The archive went wrong: ${archiveProblems(report.archive.integrity).join('; ')}. At the end, ${counted}.` }
      else if (report.archive.refused > 0) outcomes.preserve = archiveRefusal({ refusals: report.archive.refusals, integrity: report.archive.integrity, isOpsHeld, hold: HOLDS.ops, counted })
      else if (afterArchive < TAIL_POLLS) outcomes.preserve = { skipped: `Only ${afterArchive} polls came after the archive phase, ${TAIL_POLLS} are needed. At the end, ${counted}.` }
      else if (archived.size === 0) outcomes.preserve = { ok: false, isUnheld: true, line: 'No task left progress.md, so archived-question preservation could not be checked.' }
      else {
        const integrity = archiveQuestionIntegrity({ before: state.heldBefore.questions, after: held.questions, archivedSessions: archived, recoverableQuestionIds: new Set(recovery.questionIds) })
        const problems = archiveQuestionProblems(integrity)
        report.archive.questionIntegrity = integrity
        outcomes.preserve = { ok: problems.length === 0, isUnheld: problems.length === 0 ? undefined : true, line: problems.length === 0 ? `${integrity.checked} unanswered questions from archived tasks retained their IDs, original age, scope and producer provenance, source copies and recovery on the actual page; ${counted}, after ${afterArchive} polls.` : `Archived unanswered-question recovery failed: ${problems.join('; ')}. At the end, ${counted}.` }
      }
    }

    // Survival is about the server staying up and answering; slow answers are counted, and the
    // file-operation and memory checks are where slowness shows.
    const survived = `${polls.length} polls; the page server is ${isServerAlive ? 'still running' : 'gone'}; ${report.polls.failed} got no answer and ${report.polls.badStatus} got an answer other than 200 (${report.polls.slow} took longer than 15 seconds)`
    // A poll waits up to 5 minutes, longer than any slow answer seen, so a failed poll or 5 minutes
    // with no answer at the end means a server that is stuck, not slow.
    const lastAnswer = answered.at(-1)?.end ?? 0
    const isStuck = endAt - lastAnswer > POLL_GIVE_UP_MS
    // Too few polls is held only while the file-operation check fails, the slowness that explains it.
    // The poll the end cut short, after waiting at least CUT_STUCK_MS and over twice the slowest
    // answer, is a server that stopped answering in the last minutes, unless the known slowness is
    // there to explain it or the run was too short to tell (ops skipped).
    const slowestAnswer = report.polls.max ?? 0
    const isCutStuck = cutPoll !== undefined && cutPoll.ms >= CUT_STUCK_MS && cutPoll.ms > 2 * slowestAnswer && !isOpsHeld && outcomes.ops.skipped === undefined
    const stuckNote = isStuck ? `; no answer came in the last ${Math.round((endAt - lastAnswer) / 1000)} s` : isCutStuck ? `; the poll under way at the end had waited ${Math.round(cutPoll.ms / 1000)} s, over twice the slowest answer (${Math.round(slowestAnswer / 1000)} s)` : ''
    if (!isServerAlive || report.polls.failed > 0 || report.polls.badStatus > 0 || isStuck || isCutStuck) outcomes.survive = { ok: false, isUnheld: true, line: `${survived}${stuckNote}.` }
    else if (polls.length < 1000 && minutes >= 30) outcomes.survive = { ok: false, isUnheld: !isOpsHeld, line: `${survived}; a run of ${minutes} minutes should reach 1,000${isOpsHeld ? '' : ', and the file-operation check does not fail, so its known slowness does not explain it'}.` }
    else if (polls.length < 1000) outcomes.survive = { skipped: `${survived}; 1,000 polls are needed.` }
    else outcomes.survive = { ok: true, isUnheld: true, line: `${survived}.` }

    if (state.watchFramesAtArchive === undefined) outcomes.watch = { skipped: 'The run ended before the archive phase was done.' }
    else {
      const after = watch.frames - state.watchFramesAtArchive
      const isWatchAlive = watch.child.exitCode === null && watch.child.signalCode === null
      outcomes.watch = { ok: isWatchAlive && after >= 1 && watch.headed >= 1, line: `The terminal board is ${isWatchAlive ? 'still running' : 'gone'} and drew ${after} screens after the archive phase (${watch.frames} in all).${watch.errors ? ` It said: ${watch.errors.trim().split('\n').at(-1)}` : ''}` }
    }

    // Nothing grows once the archive is done, so from SETTLE_MS after it the server should set no new high.
    const settled = state.archiveEndAt === undefined ? [] : serveSamples.filter(one => one.t >= state.archiveEndAt + SETTLE_MS)
    const before = state.archiveEndAt === undefined ? undefined : peakRss(serveSamples, 0, state.archiveEndAt)
    const after = settled.length === 0 ? undefined : Math.max(...settled.map(one => one.rss))
    if (isProbeSilent) outcomes.level = silentProbe
    else if (state.archiveEndAt === undefined) outcomes.level = { skipped: 'The run ended before the archive phase was done.' }
    else outcomes.level = levelOutcome({ before, after, settled: settled.length, needed: SETTLED_LINES, settleSeconds: SETTLE_MS / 1000, archiveMinutes: Math.round((state.archiveEndAt - state.archiveStartAt) / 6000) / 10, isOpsHeld, hold: HOLDS.ops })

    report.checks = await classifySoakChecks({ outcomes, titles: TITLES, holds: HOLDS, minutes, knownFailure })
  } catch (error) {
    report.status = 'failed'
    problem(`The soak stopped on an error: ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    clearInterval(sampler)
    clearTimeout(deadline)
    isLoopDone = true
  }
  // Teardown has its own limit, so a hung close never outlives the job.
  const teardownTimer = setTimeout(() => giveUp('The teardown took over a minute and was cut short.'), 60000).unref()

  if (report.status === 'running') report.status = control.stop ?? 'finished'
  report.finishedAt = new Date().toISOString()
  save()
  // A busy page server cannot answer the world's short close request, so ask for longer, then end it.
  if (server?.isOwned()) {
    // The server is ended only when it took the request (answered, or too busy to answer in time):
    // a refused connection means nothing listens at its address, so the pid may be another
    // program's by now. The world's close ends the terminal board either way.
    let isRefused = false
    try { await fetch(new URL('/api/close', server.url), { method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(control.stop === undefined ? 20000 : 8000) }) } catch (error) { isRefused = error?.cause?.code === 'ECONNREFUSED' }
    for (let waited = 0; waited < 100 && server.isOwned(); waited += 1) await new Promise(done => setTimeout(done, 100))
    if (!isRefused) endBoards()
  }
  let closeFailure
  try { await world?.close() } catch (error) {
    closeFailure = error
    problem(`The world did not close cleanly: ${String(error?.errors?.[0]?.message ?? error?.message ?? error).split('\n')[0]}`)
  }
  clearTimeout(teardownTimer)
  const skip = minutes > HOOK_LOAD_MAX_MINUTES ? 'hook-load phase skipped: needs minutes ≤ 35 to fit the 60-minute job'
    : report.status !== 'finished' || stopper.signal.aborted ? 'hook-load phase skipped: the soak did not finish' : undefined
  if (skip !== undefined) {
    say(skip)
    report.notes.push(skip)
  } else {
    report.checks.push(...await hookLoadPhase().catch(error => [{ title: HOOK_LOAD_TITLE, status: 'fail', line: `The phase could not run: ${String(error?.message ?? error).split('\n')[0]}` }]))
  }
  save()
  for (const check of report.checks) say(`${check.status}: ${check.title} - ${check.line}`)
  if (report.checks.length > 0) say(`soak: ${tallyOf(report.checks)}`)
  if (saveFailure !== undefined) say(`soak: the report could not be written (${saveFailure.code ?? saveFailure.message}).`)
  say(`soak: ${report.status}`)
  // The default folder is in the temp folder, so a local run is told where its report went.
  if (out === OUT_DEFAULT) process.stdout.write(`soak: the report is in ${out}\n`)
  return report.status === 'finished' && closeFailure === undefined && saveFailure === undefined && !report.checks.some(check => check.status === 'fail') ? 0 : 1
}

const parsed = parseArguments(process.argv.slice(2))
if (parsed.error !== undefined) {
  process.stderr.write(`${parsed.error}\n`)
  process.exitCode = 2
} else {
  const code = await soak(parsed)
  process.stdout.write('', () => process.exit(code))
}

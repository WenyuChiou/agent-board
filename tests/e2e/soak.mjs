import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { arch, homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OUT_DEFAULT, fileOpsPerPoll, makeRedact, median, parseArguments, peakRss, percentile, tallyOf, writeReport } from './lib/soak-report.mjs'

// L6 soak: the terminal board (--watch) and the page server (--serve) run side by side on one
// isolated world while data grows to the scale budget, tasks are archived and the polling goes on.
// It is not a *.test.mjs file, so it never runs per pull request (.github/workflows/soak.yml runs it).
//   node tests/e2e/soak.mjs [--minutes 1..45] [--out DIR]

const TITLES = {
  ops: 'L6 soak: 300 polls with new asks keep file operations per poll flat',
  memory: 'L6 soak: server memory stays under 150 MB after 300 polls',
  prune: 'L6 soak: question ledger and capture files are pruned after their tasks are archived',
  survive: 'L6 soak: the page server survives 1,000 polls with no exit',
  watch: 'L6 soak: the terminal board keeps running beside the page',
  level: 'L6 soak: server memory levels off',
}
// A check that fails on main because of a known problem passes through knownFailure with its hold id:
// the page server reads every ledger and capture file on every poll (audit P1-3), so its memory
// climbs and its answers slow down to minutes; and the question ledger and capture files of an
// archived task are never removed. Survival is held only for falling short of 1,000 polls while
// the file-operation check still fails, since that slowness is what keeps a run short: a page
// server that is gone, answers with an error, drops a connection or leaves a poll unanswered for
// 5 minutes is never held, and neither is a run that reaches 1,000, which says nothing of the bug.
const HOLDS = { ops: 'hold:serve-poll-file-ops', memory: 'hold:serve-poll-file-ops', prune: 'hold:question-ledger-prune', survive: 'hold:serve-poll-file-ops' }

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
const CAPTURE = /^progress-questions-source-[a-f0-9]{64}\.json$/
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
  let world, server, watch
  // A busy page server cannot answer a close request, so the last resort ends both board processes.
  // The page server is a detached process: it is ended only while the world's address file still
  // names its pid and address, so a pid the system gave to another program is never touched.
  const endBoards = () => {
    try { if (server?.isOwned()) process.kill(server.pid) } catch {}
    try { watch?.child.kill() } catch {}
  }
  let isGivingUp = false
  const giveUp = async note => {
    if (isGivingUp) return
    isGivingUp = true
    problem(note)
    save()
    endBoards()
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
    setTimeout(() => giveUp('The soak did not stop in 30 seconds and was closed from outside.'), 30000).unref()
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
  const state = { archiveEndPolls: undefined, archiveEndAt: undefined, archivedSessions: undefined, heldBefore: undefined, watchFramesAtArchive: undefined, growthEndAt: undefined }
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

    // The ledger records and capture files of each task, by the session in their scope.
    const sessionOf = scope => { try { return JSON.parse(scope)[2] } catch { return '' } }
    const holdings = () => {
      const bySession = new Map()
      const add = (session, key) => {
        const one = bySession.get(session) ?? { records: 0, captures: 0 }
        one[key] += 1
        bySession.set(session, one)
      }
      const found = { bySession, ledgerTotal: 0, captureTotal: 0, error: undefined }
      try {
        const ledger = JSON.parse(readFileSync(join(world.claudeDir, 'progress-questions.json'), 'utf8')).records
        found.ledgerTotal = ledger.length
        for (const one of ledger) add(sessionOf(one.scope), 'records')
      } catch (error) { found.error = error.code ?? error.message }
      for (const name of readdirSync(world.claudeDir).filter(one => CAPTURE.test(one))) {
        found.captureTotal += 1
        try { add(sessionOf(JSON.parse(readFileSync(join(world.claudeDir, name), 'utf8')).record.scope), 'captures') } catch {}
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
      if (error?.name === 'TimeoutError') return 'no answer in 5 minutes'
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
    // A request that gets no answer (a busy page server, or the soak stopping) is status 0, not a crash.
    const call = async (path, body) => {
      const start = since()
      try { return await send(path, body) } catch (error) {
        if (isRunning()) problem(`A request to the page for ${path} got no answer in ${Math.round((since() - start) / 1000)} s: ${String(error?.message ?? error).split(/\r?\n/)[0]}`)
        return { status: 0, json: {} }
      }
    }
    // The archive's requests wait for their answer as a poll does, since one given up early is still
    // carried out by the server after the soak has looked; but never past the time the archive may
    // take (the planned time and ARCHIVE_SLACK_MS), so the tail still gets its polls.
    const archiveWait = () => Math.max(1000, Math.floor(Math.min(POLL_GIVE_UP_MS, total + ARCHIVE_SLACK_MS - since())))
    const send = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(archiveWait()), stopper.signal]) })
      const text = await response.text()
      let json = {}
      try { json = JSON.parse(text) } catch {}
      return { status: response.status, json }
    }

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
      // What the tasks hold just before the archive, so the prune check knows there was something to prune.
      state.heldBefore = holdings()
      const tidy = await call('/api/tidy', {})
      let refused = tidy.status === 200 ? 0 : 1
      if (tidy.status !== 200) problem(`Archive now answered ${tidy.status}.`)
      // One look at the board gives every stopped card's key and fingerprint; none of them changes meanwhile.
      let json = {}
      for (let attempt = 1; attempt <= 3 && isRunning() && json.model === undefined; attempt += 1) json = (await call('/api/board')).json
      const rows = json.model === undefined ? [] : [...json.model.groups.flatMap(group => group.rows), ...json.model.stopped, ...json.model.idle]
      for (const number of ended) {
        if (!isRunning()) break
        if (since() > total + ARCHIVE_SLACK_MS) { problem('The archive of stopped tasks was cut short because the planned time was long over.'); break }
        const title = specOf(number, 'ended').title
        const row = rows.find(one => one.title === title && one.canArchive)
        const answer = row === undefined ? { status: 0, json: {} } : await call('/api/act', { key: row.key, type: 'archive', text: '', session: '', asked: '', fp: row.fp })
        if (answer.status !== 200) {
          refused += 1
          problem(row === undefined ? 'A stopped task with a question had no Archive button.' : `Archiving a stopped task with a question answered ${answer.status}.`)
        }
      }
      await waitPolls(2)
      const present = new Set([...readFileSync(world.path, 'utf8').matchAll(/^<!-- auto session=([a-f0-9]+) /gm)].map(one => one[1]))
      const tried = [...createdSessions]
      state.archivedSessions = new Set(tried.filter(session => !present.has(session)))
      report.archive = { path: 'the page\'s own requests: Archive now for finished tasks, and the card\'s Archive button for stopped tasks that still ask something.', tried: tried.length, gone: state.archivedSessions.size, refused }
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
      await archive()
      if (!isRunning()) return
      state.archiveEndPolls = polls.length
      state.archiveEndAt = since()
      state.watchFramesAtArchive = watch.frames
      setPhase('tail')
      // The tail lasts the planned time, and then until the prune check has its polls and the
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

    if (state.archivedSessions === undefined || state.archiveEndPolls === undefined) outcomes.prune = { skipped: 'The run ended before the archive phase was done.' }
    else {
      const archived = state.archivedSessions
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
      // An unread ledger counts no record, which would read as pruned or as nothing to prune.
      if (unread !== undefined) outcomes.prune = { ok: false, isUnheld: true, line: `The question ledger could not be read ${unread}.` }
      // A refused or unanswered archive request leaves stopped tasks with questions out, the one
      // path that keeps them, so the check would no longer cover it.
      else if (report.archive.refused > 0) outcomes.prune = { ok: false, isUnheld: true, line: `${report.archive.refused} archive requests were refused or got no answer, so the archive did not finish. At the end, ${counted}.` }
      else if (afterArchive < TAIL_POLLS) outcomes.prune = { skipped: `Only ${afterArchive} polls came after the archive phase, ${TAIL_POLLS} are needed. At the end, ${counted}.` }
      else if (archived.size === 0) outcomes.prune = { ok: false, isUnheld: true, line: 'No task left progress.md, so nothing could be pruned.' }
      // With nothing there before, "none left" would prove nothing.
      else if (recordsBefore === 0 || capturesBefore === 0) outcomes.prune = { ok: false, isUnheld: true, line: `The archived tasks had ${recordsBefore} ledger records and ${capturesBefore} capture files before the archive, so there was nothing to prune.` }
      else outcomes.prune = { ok: records === 0 && captures === 0, line: `${counted}, after ${afterArchive} polls.` }
    }

    // Survival is about the server staying up and answering; slow answers are counted, and the
    // file-operation and memory checks are where slowness shows.
    const survived = `${polls.length} polls; the page server is ${isServerAlive ? 'still running' : 'gone'}; ${report.polls.failed} got no answer and ${report.polls.badStatus} got an answer other than 200 (${report.polls.slow} took longer than 15 seconds)`
    // A poll waits up to 5 minutes, longer than any slow answer seen, so a failed poll or 5 minutes
    // with no answer at the end means a server that is stuck, not slow.
    const lastAnswer = answered.at(-1)?.end ?? 0
    const isStuck = endAt - lastAnswer > POLL_GIVE_UP_MS
    // Too few polls is held only while the file-operation check fails, the slowness that explains it.
    const isOpsFailing = outcomes.ops.ok === false && outcomes.ops.isUnheld !== true
    if (!isServerAlive || report.polls.failed > 0 || report.polls.badStatus > 0 || isStuck) outcomes.survive = { ok: false, isUnheld: true, line: `${survived}${isStuck ? `; no answer came in the last ${Math.round((endAt - lastAnswer) / 1000)} s` : ''}.` }
    else if (polls.length < 1000 && minutes >= 30) outcomes.survive = { ok: false, isUnheld: !isOpsFailing, line: `${survived}; a run of ${minutes} minutes should reach 1,000${isOpsFailing ? '' : ', and the file-operation check does not fail, so its known slowness does not explain it'}.` }
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
    const levelLimit = before === undefined ? undefined : 1.1 * before + 10 * MEGABYTE
    if (isProbeSilent) outcomes.level = silentProbe
    else if (state.archiveEndAt === undefined) outcomes.level = { skipped: 'The run ended before the archive phase was done.' }
    else if (before === undefined || settled.length < SETTLED_LINES) outcomes.level = { skipped: `Only ${settled.length} memory lines came from ${SETTLE_MS / 1000} s after the archive on, ${SETTLED_LINES} are needed.` }
    else outcomes.level = { ok: after <= levelLimit, line: `The page server's highest memory was ${megabytes(before)} MB up to the end of the archive and ${megabytes(after)} MB after it (limit ${megabytes(levelLimit)} MB).` }

    // CI runs 30 minutes: a check such a run could not measure fails it, since the run then proved
    // nothing about it. A shorter run, tried by hand, may skip.
    const isFullRun = minutes >= 30
    const results = []
    for (const [key, title] of Object.entries(TITLES)) {
      const outcome = outcomes[key]
      if (outcome.skipped !== undefined) {
        results.push(isFullRun ? { title, status: 'fail', line: `Not measured in a ${minutes}-minute run: ${outcome.skipped}` } : { title, status: 'skipped', line: outcome.skipped })
        continue
      }
      const hold = HOLDS[key]
      if (hold === undefined || outcome.isUnheld) { results.push({ title, status: outcome.ok ? 'pass' : 'fail', line: outcome.line }); continue }
      try {
        await knownFailure(hold, () => { if (!outcome.ok) throw new Error(outcome.line) })
        results.push({ title, status: 'known', line: `${outcome.line} Known problem (${hold}).` })
      } catch (error) { results.push({ title, status: 'fail', line: `${error.message} ${outcome.line}` }) }
    }
    report.checks = results
  } catch (error) {
    report.status = 'failed'
    problem(`The soak stopped on an error: ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    clearInterval(sampler)
    clearTimeout(deadline)
    isLoopDone = true
  }
  // Teardown has its own limit, so a hung close never outlives the job.
  setTimeout(() => giveUp('The teardown took over a minute and was cut short.'), 60000).unref()

  if (report.status === 'running') report.status = control.stop ?? 'finished'
  report.finishedAt = new Date().toISOString()
  save()
  // A busy page server cannot answer the world's short close request, so ask for longer, then end it.
  if (server?.isOwned()) {
    try { await fetch(new URL('/api/close', server.url), { method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(control.stop === undefined ? 20000 : 8000) }) } catch {}
    for (let waited = 0; waited < 100 && server.isOwned(); waited += 1) await new Promise(done => setTimeout(done, 100))
    endBoards()
  }
  let closeFailure
  try { await world?.close() } catch (error) {
    closeFailure = error
    problem(`The world did not close cleanly: ${String(error?.errors?.[0]?.message ?? error?.message ?? error).split('\n')[0]}`)
  }
  if (closeFailure !== undefined || saveFailure !== undefined) save()
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

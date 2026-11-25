import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

export const SHAPES = ['S', 'P']
export const CHECKS = ['a', 'b', 'c', 'd']
export const DESKTOP_CHECKLIST_PATH = 'docs/validation/matrix-desktop-checklist.md'

// Seven surfaces named in docs/dev/plan-0.26.0.md (section E6a).
export const SURFACES = [
  { id: 'claude-cli', name: 'Claude Code CLI', kind: 'cli', agent: 'claude', surface: 'Claude Code', mode: 'live' },
  { id: 'codex-cli', name: 'Codex CLI', kind: 'cli', agent: 'codex', surface: 'Codex daemon', mode: 'live' },
  { id: 'agy', name: 'agy', kind: 'cli', agent: 'antigravity', surface: 'agy TUI', mode: 'mailbox' },
  { id: 'deepseek', name: 'DeepSeek Harness', kind: 'cli', agent: 'deepseek', surface: 'Web', mode: 'mailbox' },
  { id: 'claude-app', name: 'Claude desktop app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
  { id: 'codex-app', name: 'Codex app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
  { id: 'antigravity-app', name: 'Antigravity app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
]

const CHECK_LABELS = {
  a: 'a (board opens)',
  b: 'b (one question card)',
  c: 'c (reply goes in)',
  d: 'd (status right and timely)',
}

const pause = ms => new Promise(done => setTimeout(done, ms))

const currentPackageVersion = () => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const killChild = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(done => child.once('close', done))
  try { child.kill() } catch {}
  await Promise.race([exited, pause(2000)])
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch {}
    await Promise.race([exited, pause(1000)])
  }
}

// Builds an isolated throwaway home for Shape S (setup) or Shape P (plugin connector), never touching the real home.
export const buildThrowawayHome = ({ shape, tempBase } = {}) => {
  if (!SHAPES.includes(shape)) throw new Error(`Unsupported install shape: ${String(shape)}`)
  const root = mkdtempSync(join(tempBase ?? tmpdir(), `agent-board-matrix-${shape.toLowerCase()}-`))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  const configDir = join(home, '.config')
  const directories = [
    home,
    claudeDir,
    configDir,
    join(home, 'AppData', 'Local'),
    join(home, 'AppData', 'Roaming'),
    join(home, '.codex'),
    join(home, '.grok'),
    join(home, '.hermes'),
    join(configDir, 'opencode'),
    join(configDir, 'muse'),
    join(home, '.cursor'),
    join(home, '.openclaw'),
    join(home, '.dsh'),
    join(home, '.gemini', 'antigravity-cli'),
  ]
  for (const directory of directories) mkdirSync(directory, { recursive: true })

  const boardDir = shape === 'S' ? join(home, '.agent-board') : join(claudeDir, 'agent-board')
  const progress = join(boardDir, 'progress.md')
  const messagesDir = join(boardDir, 'messages')
  const inboxDir = join(boardDir, 'progress-inbox')
  const script = join(boardDir, 'agent-board.mjs')
  mkdirSync(boardDir, { recursive: true })
  mkdirSync(messagesDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  writeFileSync(progress, '', 'utf8')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`, 'utf8')

  if (shape === 'P') {
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'agent-board@agent-board': true }, connector: { progressPath: progress } }, null, 2),
      'utf8',
    )
  }

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: configDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    CLAUDE_PROGRESS_FILE: progress,
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
    HERMES_HOME: join(home, '.hermes'),
    OPENCODE_CONFIG_DIR: join(configDir, 'opencode'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'),
    DSH_HOME: join(home, '.dsh'),
    AGENT_BOARD_TEST_PID: String(process.pid),
    LANG: 'en',
  }
  delete env.AGENT_BOARD_ROUTES

  return {
    root,
    home,
    shape,
    boardDir,
    progress,
    messagesDir,
    inboxDir,
    script,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

const startBoardServer = (home, timeoutMs = 15_000) => new Promise((resolveStart, rejectStart) => {
  const child = spawn(process.execPath, [home.script, '--serve-child', '--lang', 'en', '--messages-dir', home.messagesDir], {
    env: home.env,
    cwd: dirname(home.root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    void killChild(child)
    rejectStart(new Error(`board server did not print URL within ${timeoutMs}ms: ${stderr || stdout}`))
  }, timeoutMs)

  const finishErr = error => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    rejectStart(error)
  }

  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+/)
    if (!match || settled) return
    settled = true
    clearTimeout(timer)
    const parsed = new URL(match[0])
    const token = parsed.searchParams.get('t') ?? ''
    resolveStart({
      url: match[0],
      origin: parsed.origin,
      token,
      close: async () => {
        try {
          await fetch(new URL('/api/close', parsed.origin), {
            method: 'POST',
            headers: { 'x-board-token': token, 'content-type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(2000),
          })
        } catch {}
        await killChild(child)
      },
    })
  })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', error => finishErr(error))
  child.once('close', status => finishErr(new Error(`board server exited (${status}) before ready: ${stderr || stdout}`)))
})

const failRemaining = ({ date, version, shape, surface, fromIndex, step, reason, prior }) => {
  const rows = [...prior]
  for (let i = fromIndex; i < CHECKS.length; i++) {
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: CHECK_LABELS[CHECKS[i]],
      result: 'FAIL',
      evidence: `stopped at ${step}: ${reason}`,
    })
  }
  return rows
}

const findAsk = (asks, question) => (asks ?? []).filter(one => one.text === question || (one.task && question && one.text.includes(question)))

// Runs checks a, b, c, d against an isolated throwaway home and a CLI command (or stand-in script).
export const runCliJourney = async ({
  surface,
  shape,
  cli,
  version = currentPackageVersion(),
  date = new Date().toISOString().slice(0, 10),
  timeoutMs = 10_000,
  pollMs = 40,
  tempBase,
} = {}) => {
  if (!cli) {
    return CHECKS.map(check => ({
      date,
      version,
      shape,
      surface: surface.name,
      check: CHECK_LABELS[check],
      result: 'SKIP',
      evidence: 'No CLI command configured for this surface',
    }))
  }

  const home = buildThrowawayHome({ shape, tempBase })
  const rows = []
  let server = null
  let cliChild = null
  let cliStderr = ''
  const session = `matrix-${surface.id}-${shape.toLowerCase()}-${randomBytes(4).toString('hex')}`
  const question = `Proceed with ${surface.name} (${shape}) check?`
  const replyText = `Yes, proceed for ${session}`

  try {
    server = await startBoardServer(home, Math.max(timeoutMs, 10_000))
    const headers = { 'x-board-token': server.token }

    // Check a: the board opens and serves valid HTML + board model.
    try {
      const pageRes = await fetch(server.url, { signal: AbortSignal.timeout(timeoutMs) })
      const pageHtml = await pageRes.text()
      const boardRes = await fetch(new URL('/api/board', server.origin), { headers, signal: AbortSignal.timeout(timeoutMs) })
      const boardJson = await boardRes.json()
      if (!pageRes.ok || !pageHtml.includes('Agent Board') || !boardRes.ok || !boardJson?.model?.view) {
        return failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: `page ${pageRes.status} / api ${boardRes.status}`, prior: rows })
      }
      rows.push({
        date,
        version,
        shape,
        surface: surface.name,
        check: CHECK_LABELS.a,
        result: 'PASS',
        evidence: `${server.origin} HTML 200 and /api/board 200`,
      })
    } catch (error) {
      return failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: error instanceof Error ? error.message : String(error), prior: rows })
    }

    // Check b: start CLI (asks a question + attaches delivery route) and wait for 1 matching card.
    const cliEnv = {
      ...home.env,
      AGENT_BOARD_URL: server.url,
      AGENT_BOARD_MATRIX_SHAPE: shape,
      AGENT_BOARD_MATRIX_SURFACE: surface.surface,
      AGENT_BOARD_MATRIX_SURFACE_ID: surface.id,
      AGENT_BOARD_MATRIX_AGENT: surface.agent,
      AGENT_BOARD_MATRIX_MODE: surface.mode,
      AGENT_BOARD_MATRIX_SESSION: session,
      AGENT_BOARD_MATRIX_PROGRESS: home.progress,
      AGENT_BOARD_MATRIX_QUESTION: question,
      AGENT_BOARD_MATRIX_REPLY: replyText,
    }
    cliChild = spawn(cli.command, cli.args ?? [], { env: cliEnv, cwd: dirname(home.root), stdio: ['ignore', 'pipe', 'pipe'] })
    cliChild.stderr?.setEncoding('utf8').on('data', chunk => { cliStderr += chunk })

    let matchedAsk = null
    const deadlineB = Date.now() + timeoutMs
    while (Date.now() < deadlineB) {
      if (cliChild.exitCode !== null && cliChild.exitCode !== 0) break
      const res = await fetch(new URL('/api/board', server.origin), { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
      if (res?.ok) {
        const body = await res.json().catch(() => null)
        const matching = findAsk(body?.model?.asks, question)
        if (matching.length === 1 && matching[0].delivery) {
          matchedAsk = matching[0]
          break
        }
      }
      await pause(pollMs)
    }

    if (!matchedAsk) {
      const detail = cliChild.exitCode !== null
        ? `CLI exited (${cliChild.exitCode}) before deliverable ask card appeared${cliStderr ? `: ${cliStderr.trim()}` : ''}`
        : `question card with deliverable route did not appear within ${timeoutMs}ms`
      return failRemaining({ date, version, shape, surface, fromIndex: 1, step: 'b', reason: detail, prior: rows })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: CHECK_LABELS.b,
      result: 'PASS',
      evidence: `1 card shown (${surface.agent}/${surface.surface})`,
    })

    // Check c: board sends reply via POST /api/act and verifies CLI receives and acknowledges it.
    const messageId = randomUUID()
    const actRes = await fetch(new URL('/api/act', server.origin), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        key: matchedAsk.key,
        type: 'message',
        id: messageId,
        text: replyText,
        session: matchedAsk.session ?? session,
        asked: matchedAsk.text,
        fp: matchedAsk.fp ?? '',
        connection: matchedAsk.delivery.id,
        turn: matchedAsk.delivery.turn,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const actJson = await actRes.json().catch(() => ({}))
    if (!actRes.ok) {
      return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason: `POST /api/act returned ${actRes.status} (${actJson.note ?? 'refused'})`, prior: rows })
    }

    let finalBoard = null
    let deliveredMessage = null
    const deadlineC = Date.now() + timeoutMs
    while (Date.now() < deadlineC) {
      const res = await fetch(new URL('/api/board', server.origin), { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
      if (res?.ok) {
        const body = await res.json().catch(() => null)
        const msg = body?.messaging?.messages?.find(one => one.id === messageId)
        if (msg?.status === 'acknowledged') {
          deliveredMessage = msg
          finalBoard = body
          break
        }
        if (msg?.status === 'rejected') {
          return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason: `reply rejected (${msg.error || 'rejected'})`, prior: rows })
        }
      }
      await pause(pollMs)
    }

    if (!deliveredMessage) {
      const reason = cliChild.exitCode !== null
        ? `CLI exited (${cliChild.exitCode}) without acknowledging reply${cliStderr ? `: ${cliStderr.trim()}` : ''}`
        : `CLI did not receive/acknowledge reply within ${timeoutMs}ms`
      return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason, prior: rows })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: CHECK_LABELS.c,
      result: 'PASS',
      evidence: `message acknowledged (${deliveredMessage.reply || 'ACK'})`,
    })

    // Check d: board reflects resolved/accurate state and no uncertain/stuck fallback.
    let statusBody = finalBoard
    let resolved = false
    const deadlineD = Date.now() + Math.min(2500, timeoutMs)
    while (Date.now() <= deadlineD) {
      const remainingAsks = findAsk(statusBody?.model?.asks, question)
      const isUncertain = statusBody?.model?.view?.unsure?.length > 0
      const msgOk = statusBody?.messaging?.messages?.find(one => one.id === messageId)?.status === 'acknowledged'
      if (msgOk && remainingAsks.length === 0 && !isUncertain) {
        resolved = true
        break
      }
      await pause(pollMs)
      const res = await fetch(new URL('/api/board', server.origin), { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null)
      if (res?.ok) statusBody = await res.json().catch(() => statusBody)
    }
    if (!resolved) {
      const remainingAsks = findAsk(statusBody?.model?.asks, question)
      return failRemaining({ date, version, shape, surface, fromIndex: 3, step: 'd', reason: `status mismatch (openAsks=${remainingAsks.length}, unsure=${statusBody?.model?.view?.unsure?.length ?? 0})`, prior: rows })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: CHECK_LABELS.d,
      result: 'PASS',
      evidence: 'question resolved; acknowledged status accurate',
    })
    return rows
  } finally {
    await killChild(cliChild)
    await server?.close?.()
    home.cleanup()
  }
}

export const formatMatrixTable = rows => {
  const escCell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [
    '| Date | Version | Shape | Surface | Check | Result | Evidence |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${escCell(row.date)} | ${escCell(row.version)} | ${escCell(row.shape)} | ${escCell(row.surface)} | ${escCell(row.check)} | ${escCell(row.result)} | ${escCell(row.evidence)} |`),
  ]
  return lines.join('\n')
}

export const runMatrix = async ({
  shapes = SHAPES,
  surfaces = SURFACES,
  cliFor = () => null,
  version = currentPackageVersion(),
  date = new Date().toISOString().slice(0, 10),
  timeoutMs = 10_000,
  pollMs = 40,
  tempBase,
} = {}) => {
  const rows = []
  for (const shape of shapes) {
    for (const surface of surfaces) {
      if (surface.kind === 'desktop') {
        for (const check of CHECKS) {
          rows.push({
            date,
            version,
            shape,
            surface: surface.name,
            check: CHECK_LABELS[check],
            result: 'CHECKLIST',
            evidence: `Manual checklist: ${surface.checklist ?? DESKTOP_CHECKLIST_PATH}`,
          })
        }
        continue
      }
      const cli = typeof cliFor === 'function' ? await cliFor(surface, shape) : cliFor?.[surface.id] ?? null
      const resultRows = await runCliJourney({ surface, shape, cli, version, date, timeoutMs, pollMs, tempBase })
      rows.push(...resultRows)
    }
  }
  return { rows, markdown: formatMatrixTable(rows) }
}

const parseCliArgs = argv => {
  const pick = name => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  const shapesRaw = pick('--shapes')
  const surfacesRaw = pick('--surfaces')
  const shapes = shapesRaw ? shapesRaw.split(',').map(s => s.trim()).filter(s => SHAPES.includes(s)) : SHAPES
  const surfaceIds = surfacesRaw ? new Set(surfacesRaw.split(',').map(s => s.trim())) : null
  const surfaces = surfaceIds ? SURFACES.filter(one => surfaceIds.has(one.id) || surfaceIds.has(one.name)) : SURFACES
  const version = pick('--version') ?? currentPackageVersion()
  const timeoutMs = Number(pick('--timeout-ms') ?? 10_000)
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    shapes,
    surfaces,
    version,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('Usage: node scripts/matrix-runner.mjs [--shapes S,P] [--surfaces id1,id2] [--version ver] [--timeout-ms ms] [--json]\n')
  } else {
    const out = await runMatrix({ shapes: opts.shapes, surfaces: opts.surfaces, version: opts.version, timeoutMs: opts.timeoutMs })
    process.stdout.write(opts.json ? `${JSON.stringify(out, null, 2)}\n` : `${out.markdown}\n`)
  }
}

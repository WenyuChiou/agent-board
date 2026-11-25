import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'
import { setupAgents as SETUP_AGENT_IDS } from './setup-discovery.mjs'

export const SHAPES = ['S', 'P']
export const CHECKS = ['a', 'b', 'c', 'd']
export const DESKTOP_CHECKLIST_PATH = 'docs/validation/matrix-desktop-checklist.md'

const MATRIX_STRINGS = { en: EN, 'zh-TW': ZH_TW, 'zh-CN': ZH_CN }
const stringsFor = (lang = 'en') => MATRIX_STRINGS[lang] ?? EN

// Seven surfaces named in docs/dev/plan-0.26.0.md (section E6a).
export const SURFACES = [
  { id: 'claude-cli', name: 'Claude Code CLI', kind: 'cli', agent: 'claude', surface: 'Claude Code', mode: 'live', binary: 'claude', args: [] },
  { id: 'codex-cli', name: 'Codex CLI', kind: 'cli', agent: 'codex', surface: 'Codex daemon', mode: 'live', binary: 'codex', args: ['exec'] },
  { id: 'agy', name: 'agy', kind: 'cli', agent: 'antigravity', surface: 'agy TUI', mode: 'mailbox', binary: 'agy', args: [] },
  { id: 'deepseek', name: 'DeepSeek Harness', kind: 'cli', agent: 'deepseek', surface: 'Web', mode: 'mailbox', binary: 'dsh', args: ['web'] },
  { id: 'claude-app', name: 'Claude desktop app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
  { id: 'codex-app', name: 'Codex app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
  { id: 'antigravity-app', name: 'Antigravity app', kind: 'desktop', checklist: DESKTOP_CHECKLIST_PATH },
]

const checkLabel = (check, s) => ({
  a: s.matrixCheckA,
  b: s.matrixCheckB,
  c: s.matrixCheckC,
  d: s.matrixCheckD,
}[check])

const pause = ms => new Promise(done => setTimeout(done, ms))

const currentPackageVersion = () => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const findOnPath = binary => {
  if (!binary) return null
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const probe = spawnSync(locator, [binary], { encoding: 'utf8', timeout: 3000 })
  if (probe.error || probe.status !== 0) return null
  const lines = probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return null
  if (process.platform !== 'win32') return lines[0]
  for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
    const match = lines.find(line => line.toLowerCase().endsWith(ext))
    if (match) return match
  }
  return lines[0]
}

// Wraps Windows .cmd/.bat CLI wrappers through cmd.exe so child_process.spawn starts them cleanly.
export const spawnSpecFor = (cli, platform = process.platform) => {
  const command = String(cli?.command ?? '')
  const args = (cli?.args ?? []).map(arg => String(arg))
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    for (const part of [command, ...args]) {
      if (/[\r\n]/.test(part)) throw new Error('CLI wrapper arguments cannot contain newlines.')
    }
    const quote = part => `"${part.replace(/"/g, '""')}"`
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { command, args, windowsVerbatimArguments: false }
}

// Resolves a runnable CLI command for a CLI surface from overrides, environment, or PATH binaries.
export const defaultCliFor = (overrides = {}) => surface => {
  const override = overrides[surface.id]
    ?? overrides[surface.name]
    ?? process.env[`AGENT_BOARD_MATRIX_CLI_${surface.id.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`]
  if (override) {
    if (typeof override === 'object' && override.command) return { isVendorCli: false, ...override }
    const raw = String(override).trim()
    const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(p => p.replace(/^["']|["']$/g, '')) ?? []
    if (parts.length > 0) return { command: parts[0], args: parts.slice(1), isVendorCli: false }
  }
  const binaryPath = findOnPath(surface.binary)
  if (!binaryPath) return null
  return { command: binaryPath, args: surface.args ?? [], isVendorCli: true }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SETUP_AGENT_SCRIPT = join(REPO_ROOT, 'scripts', 'setup-agent.mjs')
const MATRIX_SETUP_AGENTS = ['codex', 'antigravity', 'deepseek'].filter(id => SETUP_AGENT_IDS.includes(id))

export const matrixTaskPrompt = ({ surface, shape, question, progress }) =>
  `Run this agent-board parity check (${surface.name}, shape ${shape}): use progress file ${progress}, ask the user "${question}", wait for their board reply, and continue once the reply arrives.`

// Supplies host-specific task-prompt CLI arguments for real vendor binaries while preserving custom stand-in overrides.
export const buildCliInvocation = (surface, cli, prompt) => {
  if (!cli) return null
  const baseArgs = Array.isArray(cli.args) ? cli.args.map(arg => String(arg)) : []
  if (cli.isVendorCli !== true) return { command: cli.command, args: baseArgs }
  if (surface.id === 'claude-cli') {
    const interactiveArgs = baseArgs.filter(arg => arg !== '-p' && arg !== '--print')
    return { command: cli.command, args: [...interactiveArgs, prompt] }
  }
  if (surface.id === 'codex-cli') {
    return { command: cli.command, args: baseArgs.includes('exec') ? [...baseArgs, prompt] : ['exec', ...baseArgs, prompt] }
  }
  if (surface.id === 'agy') {
    return { command: cli.command, args: baseArgs.at(-1) === '-p' ? [...baseArgs, prompt] : [...baseArgs, '-p', prompt] }
  }
  if (surface.id === 'deepseek') {
    const cleanArgs = baseArgs.filter(arg => arg !== 'web')
    return { command: cli.command, args: cleanArgs.at(-1) === '-p' ? [...cleanArgs, prompt] : [...cleanArgs, '-p', prompt] }
  }
  return { command: cli.command, args: [...baseArgs, prompt] }
}

const killChild = async child => {
  if (!child) return
  const closed = new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) done()
    else child.once('close', done)
  })
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 })
    } else {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
      }
      try { child.kill() } catch {}
    }
    await Promise.race([closed, pause(2000)])
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 })
      } else {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }
        try { child.kill('SIGKILL') } catch {}
      }
      await Promise.race([closed, pause(1000)])
    }
  }
  try { child.stdout?.destroy() } catch {}
  try { child.stderr?.destroy() } catch {}
  try { child.stdin?.destroy() } catch {}
  await Promise.race([closed, pause(200)])
}

// Builds an isolated throwaway home for Shape S (setup) or Shape P (plugin connector), never touching the real home.
export const buildThrowawayHome = ({ shape, surface, tempBase, setupScript = SETUP_AGENT_SCRIPT, setupTimeoutMs = 30_000 } = {}) => {
  if (!SHAPES.includes(shape)) throw new Error(`Unsupported install shape: ${String(shape)}`)
  const root = mkdtempSync(join(tempBase ?? tmpdir(), `agent-board-matrix-${shape.toLowerCase()}-`))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  const configDir = join(home, '.config')
  const runtimeDir = join(root, 'runtime')
  const dataDir = join(root, 'data')
  const stateDir = join(root, 'state')
  const cacheDir = join(root, 'cache')
  const tempDir = join(root, 'tmp')
  const directories = [
    home,
    claudeDir,
    configDir,
    runtimeDir,
    dataDir,
    stateDir,
    cacheDir,
    tempDir,
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
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 })

  const boardDir = shape === 'S' ? join(home, '.agent-board') : join(claudeDir, 'agent-board')
  const progress = join(boardDir, 'progress.md')
  const messagesDir = join(boardDir, 'messages')
  const inboxDir = join(boardDir, 'progress-inbox')
  const script = join(boardDir, 'agent-board.mjs')
  mkdirSync(boardDir, { recursive: true })
  mkdirSync(messagesDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  writeFileSync(progress, '', 'utf8')

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_STATE_HOME: stateDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_RUNTIME_DIR: runtimeDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
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
  for (const key of ['AGENT_BOARD_ROUTES', 'AGENT_BOARD_RUNTIME_FOLDER', 'AGENT_BOARD_MESSAGES_DIR', 'CODEX_THREAD_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID']) {
    delete env[key]
  }

  if (shape === 'P') {
    const version = currentPackageVersion()
    const pluginInstallDir = join(claudeDir, 'plugins', 'cache', 'agent-board', 'agent-board', version)
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true })
    mkdirSync(join(pluginInstallDir, '.claude-plugin'), { recursive: true })
    const manifestSrc = join(REPO_ROOT, '.claude-plugin', 'plugin.json')
    if (existsSync(manifestSrc)) cpSync(manifestSrc, join(pluginInstallDir, '.claude-plugin', 'plugin.json'))
    const hooksSrc = join(REPO_ROOT, 'hooks')
    if (existsSync(hooksSrc)) cpSync(hooksSrc, join(pluginInstallDir, 'hooks'), { recursive: true })
    const hooksJsonSrc = join(hooksSrc, 'hooks.json')
    if (existsSync(hooksJsonSrc)) {
      const hooksJsonText = readFileSync(hooksJsonSrc, 'utf8')
      const pluginRefs = new Set()
      for (const match of hooksJsonText.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g)) {
        pluginRefs.add(match[1])
      }
      if (hooksJsonText.includes('claude-approval.mjs')) pluginRefs.add('scripts/claude-approval.mjs')
      for (const relPath of pluginRefs) {
        const srcFile = join(REPO_ROOT, ...relPath.split('/'))
        if (existsSync(srcFile)) {
          const destFile = join(pluginInstallDir, ...relPath.split('/'))
          mkdirSync(dirname(destFile), { recursive: true })
          cpSync(srcFile, destFile)
        }
      }
    }
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'agent-board@agent-board': [{ scope: 'user', version, installPath: pluginInstallDir }] } }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'agent-board@agent-board': true }, connector: { progressPath: progress } }, null, 2),
      'utf8',
    )
  }

  const setupTargets = surface?.agent
    ? (MATRIX_SETUP_AGENTS.includes(surface.agent) ? [surface.agent] : [])
    : MATRIX_SETUP_AGENTS
  if (setupTargets.length > 0) {
    const setupRes = spawnSync(
      process.execPath,
      [
        setupScript,
        '--agent', setupTargets.join(','),
        '--home', home,
        '--progress-file', progress,
        '--data-dir', boardDir,
        '--lang', 'en',
        '--apply',
        '--json',
      ],
      { env, cwd: root, encoding: 'utf8', timeout: setupTimeoutMs, windowsHide: true },
    )
    if (setupRes.error || setupRes.status !== 0) {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      const reason = setupRes.error?.message || setupRes.stderr || setupRes.stdout || `exit ${setupRes.status}`
      throw new Error(`setup-agent failed for ${setupTargets.join(',')} (status ${setupRes.status}): ${reason}`)
    }
  }
  if (!existsSync(script)) {
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${BOARD_SCRIPT}`, 'utf8')
  }

  return {
    root,
    home,
    shape,
    boardDir,
    progress,
    messagesDir,
    inboxDir,
    runtimeDir,
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

const failRemaining = ({ date, version, shape, surface, fromIndex, step, reason, prior, s }) => {
  const rows = [...prior]
  for (let i = fromIndex; i < CHECKS.length; i++) {
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: checkLabel(CHECKS[i], s),
      result: 'FAIL',
      evidence: s.matrixStoppedAt(step, reason),
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
  lang = 'en',
  timeoutMs = 10_000,
  pollMs = 40,
  tempBase,
  setupScript = SETUP_AGENT_SCRIPT,
  setupTimeoutMs = 30_000,
} = {}) => {
  const s = stringsFor(lang)
  if (!cli) {
    return CHECKS.map(check => ({
      date,
      version,
      shape,
      surface: surface.name,
      check: checkLabel(check, s),
      result: 'SKIP',
      evidence: s.matrixNoCli(surface.binary ?? surface.name),
    }))
  }

  let home = null
  try {
    home = buildThrowawayHome({ shape, surface, tempBase, setupScript, setupTimeoutMs })
  } catch (error) {
    return failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: error instanceof Error ? error.message : String(error), prior: [], s })
  }
  const rows = []
  let server = null
  let cliChild = null
  let cliStderr = ''
  let cliSpawnError = null
  const session = `matrix-${surface.id}-${shape.toLowerCase()}-${randomBytes(4).toString('hex')}`
  const question = `Proceed with ${surface.name} (${shape}) check?`
  const prompt = matrixTaskPrompt({ surface, shape, question, progress: home.progress })
  const replyText = `Yes, proceed for ${session}`

  try {
    // Check a: start board server, verify HTML + /api/board model.
    try {
      server = await startBoardServer(home, Math.max(timeoutMs, 10_000))
      const headers = { 'x-board-token': server.token }
      const pageRes = await fetch(server.url, { signal: AbortSignal.timeout(timeoutMs) })
      const pageHtml = await pageRes.text()
      const boardRes = await fetch(new URL('/api/board', server.origin), { headers, signal: AbortSignal.timeout(timeoutMs) })
      const boardJson = await boardRes.json()
      if (!pageRes.ok || !pageHtml.includes('Agent Board') || !boardRes.ok || !boardJson?.model?.view) {
        return failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: `page ${pageRes.status} / api ${boardRes.status}`, prior: rows, s })
      }
      rows.push({
        date,
        version,
        shape,
        surface: surface.name,
        check: checkLabel('a', s),
        result: 'PASS',
        evidence: `${server.origin} HTML 200 / /api/board 200`,
      })
    } catch (error) {
      return failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: error instanceof Error ? error.message : String(error), prior: rows, s })
    }

    const headers = { 'x-board-token': server.token }

    // Check b: spawn CLI and wait for 1 deliverable question card.
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
      AGENT_BOARD_MATRIX_PROMPT: prompt,
      AGENT_BOARD_MATRIX_REPLY: replyText,
    }
    try {
      const invocation = buildCliInvocation(surface, cli, prompt)
      const spec = spawnSpecFor(invocation)
      cliChild = spawn(spec.command, spec.args, {
        env: cliEnv,
        cwd: dirname(home.root),
        detached: process.platform !== 'win32',
        stdio: [surface.id === 'claude-cli' && cli.isVendorCli === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (error) {
      return failRemaining({ date, version, shape, surface, fromIndex: 1, step: 'b', reason: error instanceof Error ? error.message : String(error), prior: rows, s })
    }
    cliChild.once('error', error => { cliSpawnError = error })
    cliChild.stderr?.setEncoding('utf8').on('data', chunk => { cliStderr += chunk })

    let matchedAsk = null
    const deadlineB = Date.now() + timeoutMs
    while (Date.now() < deadlineB) {
      if (cliSpawnError) break
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
      const detail = cliSpawnError
        ? (cliSpawnError instanceof Error ? cliSpawnError.message : String(cliSpawnError))
        : cliChild.exitCode !== null
          ? `CLI exited (${cliChild.exitCode}) before deliverable ask card appeared${cliStderr ? `: ${cliStderr.trim()}` : ''}`
          : `question card with deliverable route did not appear within ${timeoutMs}ms`
      return failRemaining({ date, version, shape, surface, fromIndex: 1, step: 'b', reason: detail, prior: rows, s })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: checkLabel('b', s),
      result: 'PASS',
      evidence: `1 card (${surface.agent}/${surface.surface})`,
    })

    // Check c: send reply via POST /api/act and wait for acknowledgement from CLI.
    const messageId = randomUUID()
    try {
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
        return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason: `POST /api/act returned ${actRes.status} (${actJson.note ?? 'refused'})`, prior: rows, s })
      }
    } catch (error) {
      return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason: error instanceof Error ? error.message : String(error), prior: rows, s })
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
          return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason: `reply rejected (${msg.error || 'rejected'})`, prior: rows, s })
        }
      }
      await pause(pollMs)
    }

    if (!deliveredMessage) {
      const reason = cliChild.exitCode !== null
        ? `CLI exited (${cliChild.exitCode}) without acknowledging reply${cliStderr ? `: ${cliStderr.trim()}` : ''}`
        : `CLI did not receive/acknowledge reply within ${timeoutMs}ms`
      return failRemaining({ date, version, shape, surface, fromIndex: 2, step: 'c', reason, prior: rows, s })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: checkLabel('c', s),
      result: 'PASS',
      evidence: `acknowledged (${deliveredMessage.reply || 'ACK'})`,
    })

    // Check d: verify resolved state and accurate status.
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
      return failRemaining({ date, version, shape, surface, fromIndex: 3, step: 'd', reason: `status mismatch (openAsks=${remainingAsks.length}, unsure=${statusBody?.model?.view?.unsure?.length ?? 0})`, prior: rows, s })
    }
    rows.push({
      date,
      version,
      shape,
      surface: surface.name,
      check: checkLabel('d', s),
      result: 'PASS',
      evidence: 'acknowledged; resolved',
    })
    return rows
  } finally {
    await killChild(cliChild)
    await server?.close?.()
    home?.cleanup?.()
  }
}

export const formatMatrixTable = (rows, { lang = 'en' } = {}) => {
  const s = stringsFor(lang)
  const escCell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [
    `| ${s.matrixColDate} | ${s.matrixColVersion} | ${s.matrixColShape} | ${s.matrixColSurface} | ${s.matrixColCheck} | ${s.matrixColResult} | ${s.matrixColEvidence} |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${escCell(row.date)} | ${escCell(row.version)} | ${escCell(row.shape)} | ${escCell(row.surface)} | ${escCell(row.check)} | ${escCell(row.result)} | ${escCell(row.evidence)} |`),
  ]
  return lines.join('\n')
}

export const runMatrix = async ({
  shapes = SHAPES,
  surfaces = SURFACES,
  cliFor = defaultCliFor(),
  version = currentPackageVersion(),
  date = new Date().toISOString().slice(0, 10),
  lang = 'en',
  timeoutMs = 10_000,
  pollMs = 40,
  tempBase,
  setupScript = SETUP_AGENT_SCRIPT,
  setupTimeoutMs = 30_000,
} = {}) => {
  const s = stringsFor(lang)
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
            check: checkLabel(check, s),
            result: 'CHECKLIST',
            evidence: s.matrixManualChecklist(surface.checklist ?? DESKTOP_CHECKLIST_PATH),
          })
        }
        continue
      }
      try {
        const cli = typeof cliFor === 'function' ? await cliFor(surface, shape) : cliFor?.[surface.id] ?? null
        const resultRows = await runCliJourney({ surface, shape, cli, version, date, lang, timeoutMs, pollMs, tempBase, setupScript, setupTimeoutMs })
        rows.push(...resultRows)
      } catch (error) {
        rows.push(...failRemaining({ date, version, shape, surface, fromIndex: 0, step: 'a', reason: error instanceof Error ? error.message : String(error), prior: [], s }))
      }
    }
  }
  return { rows, markdown: formatMatrixTable(rows, { lang }) }
}

const parseCliArgs = argv => {
  const pick = name => {
    const idx = argv.indexOf(name)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  const cliOverrides = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--cli' || argv[i + 1] === undefined) continue
    const eq = argv[i + 1].indexOf('=')
    if (eq > 0) cliOverrides[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1)
  }
  const shapesRaw = pick('--shapes')
  const surfacesRaw = pick('--surfaces')
  const shapes = shapesRaw ? shapesRaw.split(',').map(s => s.trim()).filter(s => SHAPES.includes(s)) : SHAPES
  const surfaceIds = surfacesRaw ? new Set(surfacesRaw.split(',').map(s => s.trim())) : null
  const surfaces = surfaceIds ? SURFACES.filter(one => surfaceIds.has(one.id) || surfaceIds.has(one.name)) : SURFACES
  const version = pick('--version') ?? currentPackageVersion()
  const lang = pick('--lang') ?? 'en'
  const timeoutMs = Number(pick('--timeout-ms') ?? 10_000)
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    shapes,
    surfaces,
    cliOverrides,
    version,
    lang,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${stringsFor(opts.lang).matrixUsage}\n`)
  } else {
    const out = await runMatrix({
      shapes: opts.shapes,
      surfaces: opts.surfaces,
      cliFor: defaultCliFor(opts.cliOverrides),
      version: opts.version,
      lang: opts.lang,
      timeoutMs: opts.timeoutMs,
    })
    process.stdout.write(opts.json ? `${JSON.stringify(out, null, 2)}\n` : `${out.markdown}\n`)
  }
}

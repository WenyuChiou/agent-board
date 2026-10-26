import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = fileURLToPath(new URL('../..', import.meta.url))
const setup = fileURLToPath(new URL('../../scripts/setup-agent.mjs', import.meta.url))
const fixturePrefix = 'agent-board-browser-'

const playwrightModule = process.env.AGENT_BOARD_PLAYWRIGHT_MODULE
if (!playwrightModule || !isAbsolute(playwrightModule) || extname(playwrightModule) !== '.mjs' || !existsSync(playwrightModule)) {
  throw new Error('AGENT_BOARD_PLAYWRIGHT_MODULE must name an existing absolute Playwright .mjs module')
}

const loaded = await import(pathToFileURL(playwrightModule).href)
if (!loaded.chromium) throw new Error(`AGENT_BOARD_PLAYWRIGHT_MODULE does not export chromium: ${playwrightModule}`)
export const chromium = loaded.chromium

const requestedArtifacts = process.env.AGENT_BOARD_BROWSER_ARTIFACTS_DIR
if (requestedArtifacts && !isAbsolute(requestedArtifacts)) throw new Error('AGENT_BOARD_BROWSER_ARTIFACTS_DIR must be absolute')
export const artifacts = requestedArtifacts
  ? resolve(requestedArtifacts)
  : mkdtempSync(join(tmpdir(), 'agent-board-browser-artifacts-'))
mkdirSync(artifacts, { recursive: true })

const isolatedEnvironment = root => {
  const home = join(root, 'home')
  const directories = {
    home,
    codex: join(root, 'codex'),
    claude: join(root, 'claude'),
    grok: join(root, 'grok'),
    hermes: join(root, 'hermes'),
    openclaw: join(root, 'openclaw'),
    deepseek: join(root, 'deepseek'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: join(root, 'cache'),
    opencode: join(root, 'opencode'),
    appdata: join(root, 'appdata'),
    localappdata: join(root, 'localappdata'),
    temporary: join(root, 'temporary'),
    runtime: join(root, 'private-runtime'),
  }
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: directories.codex,
    CLAUDE_CONFIG_DIR: directories.claude,
    GROK_HOME: directories.grok,
    HERMES_HOME: directories.hermes,
    OPENCLAW_STATE_DIR: directories.openclaw,
    DSH_HOME: directories.deepseek,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_STATE_HOME: directories.state,
    XDG_CACHE_HOME: directories.cache,
    OPENCODE_CONFIG_DIR: directories.opencode,
    APPDATA: directories.appdata,
    LOCALAPPDATA: directories.localappdata,
    TEMP: directories.temporary,
    TMP: directories.temporary,
    TMPDIR: directories.temporary,
    XDG_RUNTIME_DIR: directories.runtime,
    CLAUDE_PROGRESS_FILE: join(root, 'board', 'progress.md'),
    AGENT_BOARD_CODEX: join(root, 'unavailable-ai-binary'),
    AGENT_BOARD_GROK: join(root, 'unavailable-ai-binary'),
    AGENT_BOARD_HERMES: join(root, 'unavailable-ai-binary'),
    AGENT_BOARD_OPENCLAW: join(root, 'unavailable-ai-binary'),
    AGENT_BOARD_DEEPSEEK: join(root, 'unavailable-ai-binary'),
    NO_COLOR: '1',
  }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [...new Set([
    dirname(process.execPath),
    ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin']),
  ])].join(delimiter)
  delete env.CODEX_THREAD_ID
  delete env.AGENT_BOARD_AGENT
  delete env.AGENT_BOARD_SESSION_ID
  return { directories, env, home, progress: env.CLAUDE_PROGRESS_FILE }
}

const commandEvidence = async (evidence, label, file, args, env, cwd = repository) => {
  let record
  try {
    const result = await execFileAsync(process.execPath, [file, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    record = { command: [process.execPath, file, ...args], cwd, status: 0, signal: null, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    record = { command: [process.execPath, file, ...args], cwd, status: Number.isInteger(error.code) ? error.code : null, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.message }
  }
  writeFileSync(join(evidence, `${label}.json`), `${JSON.stringify(record, null, 2)}\n`)
  if (record.status !== 0) throw new Error(`${label} failed with status ${record.status}: ${record.stderr}`)
  return record
}

const nodeJson = async (evidence, label, file, args, env) => {
  const result = await commandEvidence(evidence, label, file, args, env)
  return JSON.parse(result.stdout)
}

const assertOwnedPreview = (preview, root) => {
  for (const plan of preview.plans) {
    assert.deepEqual(plan.conflicts, [])
    for (const { file } of plan.changes) {
      const path = relative(root, file)
      assert.ok(isAbsolute(file) && path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`), 'setup would write outside its owned fixture')
    }
  }
}

const findServerRecord = (root, url) => {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = visit(path)
        if (found) return found
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = JSON.parse(readFileSync(path, 'utf8'))
          if (value.url === url && Number.isInteger(value.pid) && value.pid > 0) return { path, pid: value.pid }
        } catch {}
      }
    }
    return null
  }
  return visit(root)
}

const isAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

const stopOwnedProcess = (pid, evidence) => {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const args = ['/PID', String(pid), '/T', '/F']
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    writeFileSync(join(evidence, 'owned-server-stop.json'), JSON.stringify({ command: [executable, ...args], status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2))
    if ((result.error || result.status !== 0) && isAlive(pid)) throw new Error('Owned server could not be stopped; fixture retained')
  } else {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

const closeServer = async (server, evidence) => {
  if (!server) return
  const url = new URL(server.url)
  try {
    await fetch(new URL('/api/close', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': url.searchParams.get('t') || '' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    })
  } catch {}
  const until = Date.now() + 5_000
  while (server.record && existsSync(server.record.path) && Date.now() < until) {
    await new Promise(done => setTimeout(done, 50))
  }
  if (server.record && isAlive(server.record.pid)) stopOwnedProcess(server.record.pid, evidence)
  const exitBy = Date.now() + 2000
  while (server.record && isAlive(server.record.pid) && Date.now() < exitBy) await new Promise(done => setTimeout(done, 25))
  if (server.record && isAlive(server.record.pid)) throw new Error('Owned server is still alive; fixture retained')
}

const removeOwnedRoot = async (root, evidence) => {
  const target = resolve(root)
  assert.equal(dirname(target), resolve(tmpdir()))
  assert.ok(basename(target).startsWith(fixturePrefix))
  // Windows can retain a directory briefly after the verified server/browser exit.
  // Retry only transient removal failures, and retain the root on a bounded failure.
  const started = Date.now(), failures = []
  for (;;) {
    try {
      rmSync(target, { recursive: true, force: true })
      writeFileSync(join(evidence, 'fixture-cleanup.json'), JSON.stringify({ root: target, elapsedMs: Date.now() - started, removed: true, failures }, null, 2))
      return
    } catch (error) {
      failures.push({ code: error.code, syscall: error.syscall, path: error.path, atMs: Date.now() - started })
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || Date.now() - started >= 20000) {
        writeFileSync(join(evidence, 'fixture-cleanup.json'), JSON.stringify({ root: target, removed: false, failures }, null, 2))
        throw error
      }
      await new Promise(done => setTimeout(done, Math.min(250, 25 * failures.length)))
    }
  }
}

const awaitRecoveryExit = async data => {
  const until = Date.now() + 10_000
  for (;;) {
    const claims = readdirSync(data).filter(name => /^hook-recovery-[a-f0-9]{64}\.json$/.test(name))
    const active = claims.some(name => {
      try {
        const claim = JSON.parse(readFileSync(join(data, name), 'utf8'))
        assert.ok(Number.isInteger(claim.pid) && claim.pid > 0)
        return isAlive(claim.pid)
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    })
    if (!active) return
    if (Date.now() >= until) throw new Error('A recovery owner is still alive; fixture retained')
    await new Promise(done => setTimeout(done, 50))
  }
}

export const browserFixture = async (name, run) => {
  const root = mkdtempSync(join(tmpdir(), fixturePrefix))
  const evidence = join(artifacts, `${name}-${process.pid}-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  const { directories, env, home, progress } = isolatedEnvironment(root)
  const boardRoot = join(root, 'board')
  const installedScript = join(home, '.agent-board', 'agent-board.mjs')
  const hooks = join(directories.codex, 'hooks.json')
  const auth = join(directories.codex, 'auth.json')
  mkdirSync(dirname(hooks), { recursive: true })
  const foreignHooks = { auth: { mode: 'synthetic-preserved' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo synthetic-foreign-hook' }] }] } }
  const foreignAuth = '{"synthetic":"preserve-this-byte-for-byte"}\n'
  writeFileSync(hooks, `${JSON.stringify(foreignHooks, null, 2)}\n`)
  writeFileSync(auth, foreignAuth)
  const setupArgs = ['--home', home, '--agent', 'codex', '--codex-dir', directories.codex, '--progress-file', progress, '--lang', 'en']
  let browser
  let context
  let page
  let server
  let failure
  try {
    const preview = await nodeJson(evidence, 'setup-preview', setup, setupArgs, env)
    assert.equal(preview.applied, false)
    assert.ok(preview.plans[0].changes.length > 0)
    assertOwnedPreview(preview, root)
    const applied = await nodeJson(evidence, 'setup-apply', setup, [...setupArgs, '--apply'], env)
    assert.equal(applied.applied, true)
    const repeated = await nodeJson(evidence, 'setup-repeat-preview', setup, setupArgs, env)
    assert.deepEqual(repeated.plans[0].changes, [])
    assert.deepEqual(JSON.parse(readFileSync(hooks, 'utf8')).auth, foreignHooks.auth)
    assert.deepEqual(JSON.parse(readFileSync(hooks, 'utf8')).hooks.Stop[0], foreignHooks.hooks.Stop[0])
    assert.equal(readFileSync(auth, 'utf8'), foreignAuth)
    const doctor = await nodeJson(evidence, 'doctor', installedScript, ['--codex-doctor', '--agent', 'codex', '--home', home, '--codex-dir', directories.codex, '--progress-file', progress, '--lang', 'en'], env)
    assert.equal(doctor.installed, true)
    assert.equal(doctor.connected, 'unverified')
    assert.equal(doctor.capabilities.liveReply, false)

    browser = await chromium.launch({ headless: true, env })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    page = await context.newPage()
    const startServer = async () => {
      const result = await commandEvidence(evidence, 'serve', installedScript, ['--serve', '--no-open', '--quiet-board', '--lang', 'en'], env, boardRoot)
      const url = result.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]
      assert.ok(url, result.stdout)
      server = { url, record: findServerRecord(root, url) }
      assert.ok(server.record, 'the owned localhost server record was not found below the fixture root')
      return url
    }
    await run({ root, env, home, progress, installedScript, evidence, page, startServer })
  } catch (error) {
    failure = error
    throw error
  } finally {
    const errors = []
    const finish = async action => {
      try { await action() } catch (error) { errors.push(error) }
    }
    if (page) await finish(() => page.screenshot({ path: join(evidence, `${failure ? 'failure' : 'final'}.png`), fullPage: true }))
    if (context) await finish(() => context.tracing.stop({ path: join(evidence, 'trace.zip') }))
    if (context) await finish(() => context.close())
    if (browser) await finish(() => browser.close())
    await finish(() => closeServer(server, evidence))
    if (!errors.length && existsSync(dirname(installedScript))) await finish(() => awaitRecoveryExit(dirname(installedScript)))
    if (!errors.length) await finish(() => removeOwnedRoot(root, evidence))
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Browser evidence or cleanup failed')
  }
}

export const writeProgress = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export const monthlyArchive = progress => {
  const prefix = `progress-archive-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  return readdirSync(dirname(progress))
    .filter(name => name.startsWith(prefix) && name.endsWith('.md'))
    .map(name => readFileSync(join(dirname(progress), name), 'utf8'))
    .join('\n')
}

export const hiddenQuestion = (progress, words) => {
  const answeredFile = join(dirname(progress), 'progress-answered.json')
  const questionsFile = join(dirname(progress), 'progress-questions.json')
  assert.ok(existsSync(answeredFile) && statSync(answeredFile).isFile())
  assert.ok(existsSync(questionsFile) && statSync(questionsFile).isFile())
  const answered = JSON.parse(readFileSync(answeredFile, 'utf8')).answered
  const record = JSON.parse(readFileSync(questionsFile, 'utf8')).records.find(one => one.words === words)
  assert.ok(record, `no question ledger record for ${words}`)
  return { id: record.id, isHidden: answered.includes(record.id) }
}

export const installAntigravity = async ({ root, env, home, progress, evidence }) => {
  const args = ['--home', home, '--agent', 'antigravity', '--progress-file', progress, '--lang', 'en']
  const preview = await nodeJson(evidence, 'antigravity-setup-preview', setup, args, env)
  assertOwnedPreview(preview, root)
  await nodeJson(evidence, 'antigravity-setup-apply', setup, [...args, '--apply'], env)
  const hooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'))['agent-board-local']
  return (event, payload, extraEnv = {}) => {
    const command = hooks[event]?.[0]?.command
    assert.equal(typeof command, 'string')
    const executable = process.platform === 'win32' ? join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh'
    const shellArgs = process.platform === 'win32' ? ['/d', '/v:off', '/c', command] : ['-c', command]
    const result = spawnSync(executable, shellArgs, {
      cwd: root, env: { ...env, ...extraEnv }, input: JSON.stringify(payload),
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    writeFileSync(join(evidence, `antigravity-${event}.json`), JSON.stringify({ command: [executable, ...shellArgs], status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2), { flag: 'wx' })
    assert.equal(result.status, 0, result.stderr)
  }
}

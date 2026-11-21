import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})

const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
const { liveBoardPage } = await import('../hooks/live-page.ts')
const { deepseekLocalPlugin } = await import('../hooks/portable-agents.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { buildView } = await import('../hooks/view.ts')
const { startServer } = await import('../scripts/board-serve.ts')
const { addressFileName, addressKey } = await import('../hooks/receiver.ts')
const { privateRuntimeFolder, writePrivateRuntimeFile } = await import('../scripts/runtime-folder.ts')

const MACHINE_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec']
const OPEN_LINK_RE = /http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+/
const REUSABLE_LINK_RE = /\?t=/

const isolatedEnv = (root, run, extra = {}) => {
  const home = join(root, 'home')
  const temp = join(root, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(join(home, '.config'), { recursive: true })
  mkdirSync(join(home, '.local', 'share'), { recursive: true })
  mkdirSync(join(home, '.cache'), { recursive: true })
  mkdirSync(temp, { recursive: true })
  mkdirSync(run, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') mkdirSync(join(run, 'agent-board'), { recursive: true })
  const base = Object.fromEntries(MACHINE_ENV_KEYS.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: run,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    CLAUDE_PROGRESS_FILE: '',
    AGENT_BOARD_TEST_PID: '',
    NO_COLOR: '1',
    CI: '',
    ...extra,
  }
}

const patchedBoardScript = ({ progress, openResult, openLog, envSetup }) => {
  const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
  const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
  assert.ok(opening > 0 && opened > opening, 'locates openInBrowser in BOARD_SCRIPT')
  const logHook = openLog
    ? `process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(openLog)}, target + '\\n'); `
    : ''
  const envPatch = envSetup ? `${envSetup}\n` : ''
  const stub = `var openInBrowser = (target, done) => { if (isNoWindowHere()) return done(false); ${logHook}done(${JSON.stringify(openResult)}) }\n`
  return `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${envPatch}${BOARD_SCRIPT.slice(0, opening)}${stub}${BOARD_SCRIPT.slice(opened)}`
}

const findRecords = run => {
  if (!existsSync(run)) return []
  return readdirSync(run, { recursive: true })
    .map(name => String(name))
    .filter(name => /agent-board-[a-f0-9]+\.json$/.test(name))
    .flatMap(name => {
      const file = join(run, name)
      try {
        return [{ file, ...JSON.parse(readFileSync(file, 'utf8')) }]
      } catch {
        return []
      }
    })
}

const isAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

const removeDir = async dir => {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}

const closeRuntimeServers = async run => {
  const records = findRecords(run)
  for (const record of records) {
    if (typeof record.url === 'string') {
      try {
        const parsed = new URL(record.url)
        await fetch(new URL('/api/close', parsed), {
          method: 'POST',
          headers: { 'x-board-token': parsed.searchParams.get('t') ?? '', 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(3000),
        })
      } catch {}
    }
    if (Number.isInteger(record.pid) && record.pid !== process.pid) {
      for (let i = 0; i < 40 && isAlive(record.pid); i++) await new Promise(done => setTimeout(done, 100))
      if (isAlive(record.pid)) {
        try { process.kill(record.pid) } catch {}
        for (let i = 0; i < 20 && isAlive(record.pid); i++) await new Promise(done => setTimeout(done, 100))
      }
    }
  }
}

const runCli = (script, args, env, timeout = 20_000) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ status: error ? error.code : 0, stdout, stderr })
    })
  })

const withCliFixture = async ({ openResult = true, recordOpen = false, extraEnv = {} } = {}, runTest) => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-cli-'))
  const run = join(root, 'run')
  const env = isolatedEnv(root, run, extraEnv)
  const progress = join(root, 'progress.md')
  const openLog = recordOpen ? join(root, 'open-calls.log') : null
  const script = join(root, 'agent-board.mjs')
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  writeFileSync(script, patchedBoardScript({ progress, openResult, openLog }))
  let failed = false
  try {
    await runTest({ root, run, env, progress, script, openLog })
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await closeRuntimeServers(run)
      await removeDir(root)
    } catch (cleanupError) {
      if (!failed) throw cleanupError
    }
  }
}

const startDirectBoard = async ({ now, openLinkMs, open } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-srv-'))
  const progress = join(root, 'progress.md')
  const messages = join(root, 'messages')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(messages, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  const addressFile = join(runtimeDir, addressFileName(addressKey(progress)))
  const opened = []
  let stopped
  const isStopped = new Promise(done => { stopped = done })
  const address = await new Promise((resolve, reject) => {
    startServer({
      port: 0,
      messagesDirectory: messages,
      routes: [],
      s: EN,
      ping: { ok: true },
      addressFile,
      view: () => buildView(parseProgress(readFileSync(progress, 'utf8')), [], null, Date.now(), 0, {}, EN),
      pending: () => [],
      act: () => '',
      tidy: () => '',
      clean: () => '',
      sweep: () => {},
      sweepMs: 60_000,
      paste: () => ({ isAdded: false, note: '' }),
      failure: () => null,
      idleMs: 0,
      ...(now === undefined ? {} : { now }),
      ...(openLinkMs === undefined ? {} : { openLinkMs }),
      watch: { progress, inbox: join(root, 'inbox'), fs: () => Object.assign(new EventEmitter(), { close: () => {} }) },
      open: async url => { opened.push(url); return open ? open(url) : true },
      onReady: url => { resolve(url); return true },
      onListenError: reject,
      onStop: () => stopped(),
    })
  })
  writeFileSync(addressFile, JSON.stringify({ pid: process.pid, port: Number(new URL(address).port), url: address, path: progress, built: '' }))
  const parsed = new URL(address)
  const token = parsed.searchParams.get('t')
  const origin = parsed.origin
  const call = async (path, body, headers = {}) => {
    const res = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = {}
    try { data = text === '' ? {} : JSON.parse(text) } catch {}
    return { status: res.status, text, body: data, headers: res.headers }
  }
  const close = async () => {
    await call('/api/close', {}).catch(() => undefined)
    await isStopped
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  return { root, origin, token, addressFile, opened, call, close }
}

const sessionFromHtml = html => {
  const match = /<script type="application\/json" id="page-session">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, 'HTML embeds #page-session JSON')
  const value = JSON.parse(match[1])
  assert.equal(typeof value, 'string')
  assert.ok(value.length >= 16)
  return value
}

test('opened browser window prints no token or URL on --html, plain command, and --serve', { timeout: 30_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true }, async ({ run, env, script, openLog }) => {
    for (const args of [['--html'], [], ['--serve']]) {
      const result = await runCli(script, args, env)
      assert.equal(result.status, 0, `${args.join(' ') || 'plain'}: ${result.stderr}`)
      assert.equal(result.stderr, '')
      assert.ok(result.stdout.includes('Opened Agent Board in your browser.'), result.stdout)
      assert.doesNotMatch(result.stdout, /\?t=|\/open\/|http:\/\/127\.0\.0\.1/)
    }
    const calls = readFileSync(openLog, 'utf8').trim().split(/\r?\n/)
    assert.equal(calls.length, 3)
    for (const openedUrl of calls) {
      assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+/)
      assert.doesNotMatch(openedUrl, REUSABLE_LINK_RE)
    }
    assert.equal(findRecords(run).length, 1)
  })
})

test('already-open browser window prints no token or URL on --html and --serve', { timeout: 30_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true }, async ({ run, env, script, openLog }) => {
    const start = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(start.status, 0, start.stderr)
    const records = findRecords(run)
    assert.equal(records.length, 1)
    const serverUrl = new URL(records[0].url)
    const boardRes = await fetch(new URL('/api/board', serverUrl), {
      headers: {
        'x-board-token': serverUrl.searchParams.get('t'),
        'x-board-page': 'page-visible',
        'x-board-visible': '1',
      },
    })
    assert.equal(boardRes.status, 200)

    for (const args of [['--html'], ['--serve']]) {
      const result = await runCli(script, args, env)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.ok(result.stdout.includes('Agent Board is already open in your browser.'), result.stdout)
      assert.doesNotMatch(result.stdout, /\?t=|\/open\/|http:\/\/127\.0\.0\.1/)
    }
    assert.equal(existsSync(openLog), false, 'openInBrowser is not called when a window is already visible')
  })
})

test('failed browser opener prints a one-use link whose second GET is refused', { timeout: 30_000 }, async () => {
  await withCliFixture({ openResult: false }, async ({ run, env, script }) => {
    const htmlRun = await runCli(script, ['--html'], env)
    assert.equal(htmlRun.status, 0, htmlRun.stderr)
    assert.equal(htmlRun.stderr, '')
    assert.doesNotMatch(htmlRun.stdout, REUSABLE_LINK_RE)
    const htmlMatch = OPEN_LINK_RE.exec(htmlRun.stdout)
    assert.ok(htmlMatch, `expected one-use link in stdout:\n${htmlRun.stdout}`)
    assert.match(htmlRun.stdout, /No browser found\. Open this address in your browser:/)

    const records = findRecords(run)
    assert.equal(records.length, 1)
    const addressToken = new URL(records[0].url).searchParams.get('t')
    const oneUseUrl = htmlMatch[0]

    const serveRun = await runCli(script, ['--serve'], env)
    assert.equal(serveRun.status, 0, serveRun.stderr)
    assert.doesNotMatch(serveRun.stdout, REUSABLE_LINK_RE)
    assert.doesNotMatch(serveRun.stderr, REUSABLE_LINK_RE)
    const serveOutUrl = OPEN_LINK_RE.exec(serveRun.stdout)?.[0]
    const serveErrUrl = OPEN_LINK_RE.exec(serveRun.stderr)?.[0]
    assert.ok(serveOutUrl && serveErrUrl)
    assert.equal(serveOutUrl, serveErrUrl, '--serve stdout and stderr share the exact same one-use link')

    const firstGet = await fetch(oneUseUrl)
    assert.equal(firstGet.status, 200)
    const setCookie = firstGet.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /agent_board_session=[\w-]+/)
    assert.match(setCookie, /\bHttpOnly\b/i)
    assert.match(setCookie, /\bSameSite=Strict\b/i)
    assert.match(setCookie, /\bPath=\//i)
    const html = await firstGet.text()
    assert.equal(html.includes(addressToken), false, 'page HTML never discloses the reusable address-file token')
    sessionFromHtml(html)

    const secondGet = await fetch(oneUseUrl)
    assert.equal(secondGet.status, 403, 'second GET to one-use link must be refused')

    const cookiePair = setCookie.split(';')[0]
    const reload = await fetch(new URL('/', oneUseUrl), { headers: { cookie: cookiePair } })
    assert.equal(reload.status, 200, 'reloading / with session cookie succeeds')
    const unauth = await fetch(new URL('/', oneUseUrl))
    assert.equal(unauth.status, 403, 'GET / without session cookie is refused')

    assert.equal((await fetch(serveOutUrl)).status, 200)
    assert.equal((await fetch(serveOutUrl)).status, 403)
  })
})

test('--no-open and SSH fallbacks print only a one-use link with no reusable token', { timeout: 30_000 }, async () => {
  await withCliFixture({ openResult: true }, async ({ env, script }) => {
    const htmlNoOpen = await runCli(script, ['--html', '--no-open'], env)
    assert.equal(htmlNoOpen.status, 0, htmlNoOpen.stderr)
    assert.doesNotMatch(htmlNoOpen.stdout, REUSABLE_LINK_RE)
    const link1 = htmlNoOpen.stdout.trim()
    assert.match(link1, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/)
    assert.equal((await fetch(link1)).status, 200)
    assert.equal((await fetch(link1)).status, 403)

    const serveNoOpen = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(serveNoOpen.status, 0, serveNoOpen.stderr)
    assert.doesNotMatch(serveNoOpen.stdout, REUSABLE_LINK_RE)
    const link2 = OPEN_LINK_RE.exec(serveNoOpen.stdout)?.[0]
    assert.ok(link2)
    assert.notEqual(link2, link1)
    assert.equal((await fetch(link2)).status, 200)
    assert.equal((await fetch(link2)).status, 403)

    const sshEnv = { ...env, SSH_CONNECTION: '203.0.113.5 50000 203.0.113.9 2222', SSH_TTY: '/dev/pts/0' }
    const keysRes = await runCli(script, ['--keys', 'o', '--no-open'], sshEnv)
    assert.equal(keysRes.status, 0, keysRes.stderr)
    assert.doesNotMatch(keysRes.stdout, REUSABLE_LINK_RE)
    const linkKeys = OPEN_LINK_RE.exec(keysRes.stdout)?.[0]
    assert.ok(linkKeys, keysRes.stdout)
    assert.equal((await fetch(linkKeys)).status, 200)
    assert.equal((await fetch(linkKeys)).status, 403)

    // With page loaded above, start a clean second SSH fixture to cover before-open and already-open SSH output.
  })

  await withCliFixture({ openResult: true }, async ({ env, script }) => {
    const sshEnv = { ...env, SSH_CONNECTION: '203.0.113.5 50000 203.0.113.9 2222', SSH_TTY: '/dev/pts/0' }
    const firstSsh = await runCli(script, [], sshEnv)
    assert.equal(firstSsh.status, 0, firstSsh.stderr)
    assert.doesNotMatch(firstSsh.stdout, REUSABLE_LINK_RE)
    const firstLines = firstSsh.stdout.trim().split(/\r?\n/)
    const sshUrl1 = firstLines.at(-1)
    assert.match(sshUrl1, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/)
    const port = Number(new URL(sshUrl1).port)
    assert.equal(firstLines.at(-2), EN.serveSshHint(port, '-p 2222 203.0.113.9', sshUrl1))
    assert.equal((await fetch(sshUrl1)).status, 200)
    assert.equal((await fetch(sshUrl1)).status, 403)

    const againSsh = await runCli(script, [], sshEnv)
    assert.equal(againSsh.status, 0, againSsh.stderr)
    assert.doesNotMatch(againSsh.stdout, REUSABLE_LINK_RE)
    const againLines = againSsh.stdout.trim().split(/\r?\n/)
    const sshUrl2 = OPEN_LINK_RE.exec(againLines.at(-2) ?? '')?.[0]
    assert.ok(sshUrl2 && sshUrl2 !== sshUrl1, againSsh.stdout)
    assert.equal(againLines.at(-2), EN.serveSshHint(port, '-p 2222 203.0.113.9', sshUrl2))
    assert.equal(againLines.at(-1), EN.boardPageAlreadyOpen)
    assert.equal((await fetch(sshUrl2)).status, 200)
    assert.equal((await fetch(sshUrl2)).status, 403)
  })
})

test('concurrent and non-GET requests against a one-use link consume it at most once', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    assert.equal((await board.call('/api/open-link', {}, { origin: board.origin })).status, 403)
    const minted = await board.call('/api/open-link', {})
    assert.equal(minted.status, 200)
    assert.match(minted.body.url, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/)
    const oneUseUrl = minted.body.url

    assert.equal((await fetch(oneUseUrl, { method: 'HEAD' })).status, 405)
    assert.equal((await fetch(oneUseUrl, { headers: { 'sec-purpose': 'prefetch' } })).status, 403)

    // Invalid Host header gets 421 and must not consume the code (use node:http to send custom Host header).
    const http = await import('node:http')
    const target = new URL(oneUseUrl)
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: target.port, method: 'GET', path: target.pathname, headers: { host: `evil.example:${target.port}` } }, res => {
        res.resume().on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(badHostStatus, 421)

    const [a, b] = await Promise.all([fetch(oneUseUrl), fetch(oneUseUrl)])
    assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 403])
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('expired one-use link and bounded open-link cap refuse stale or evicted codes', { timeout: 20_000 }, async () => {
  let clock = 1_000_000
  const board = await startDirectBoard({ now: () => clock, openLinkMs: 5_000 })
  let failed = false
  try {
    const first = await board.call('/api/open-link', {})
    assert.equal(first.status, 200)
    clock += 6_000
    assert.equal((await fetch(first.body.url)).status, 403)

    const links = []
    for (let i = 0; i < 65; i += 1) {
      const minted = await board.call('/api/open-link', {})
      assert.equal(minted.status, 200)
      links.push(minted.body.url)
    }
    assert.equal((await fetch(links[0])).status, 403, 'oldest link evicted beyond cap 64')
    assert.equal((await fetch(links[64])).status, 200)
    assert.equal((await fetch(links[64])).status, 403)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('page session cannot call client-only control routes, and /api/open uses a one-use link that pairs the page secret for /api/approvals/switch', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 200)
    assert.equal(board.opened.length, 1)
    assert.match(board.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+#k=[\w-]+$/)
    assert.doesNotMatch(board.opened[0], REUSABLE_LINK_RE)

    const [openUrl, fragment] = board.opened[0].split('#')
    const pairKey = /^k=([\w-]+)$/.exec(fragment)?.[1]
    assert.ok(pairKey)

    const redeemed = await fetch(openUrl)
    assert.equal(redeemed.status, 200)
    const html = await redeemed.text()
    const pageSession = sessionFromHtml(html)
    assert.notEqual(pageSession, board.token)
    assert.equal((await fetch(openUrl)).status, 403)

    const asPage = (path, body, extra = {}) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': pageSession,
        'x-board-page': 'p-one-use',
        origin: board.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    assert.equal((await asPage('/api/board')).status, 200)
    assert.equal((await asPage('/api/ping')).status, 403)
    assert.equal((await asPage('/api/open', { asApp: true })).status, 403)
    assert.equal((await asPage('/api/open-link', {})).status, 403)
    assert.equal((await asPage('/api/lan', { address: '' })).status, 403)
    assert.equal((await asPage('/api/package', { version: '9.9.9' })).status, 403)
    assert.equal((await asPage('/api/approvals/ask', {})).status, 403)
    assert.equal((await asPage('/api/messages/register', {})).status, 403)

    const paired = await asPage('/api/approvals/pair', { key: pairKey })
    assert.equal(paired.status, 200)
    const secret = (await paired.json()).secret
    assert.equal(typeof secret, 'string')
    assert.ok(secret.length > 0)

    const switchClientOnly = await board.call('/api/approvals/switch', { enabled: false }, { origin: board.origin, 'x-board-page': 'p-one-use' })
    assert.equal(switchClientOnly.status, 403)
    const switchWithoutSecret = await asPage('/api/approvals/switch', { enabled: false })
    assert.equal(switchWithoutSecret.status, 403)

    const switched = await asPage('/api/approvals/switch', { enabled: false }, { 'x-board-approve': secret })
    assert.equal(switched.status, 200)
    assert.equal((await switched.json()).isOff, true)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('DeepSeek agent_board open tool returns no reusable token on opened window or failed open', { timeout: 40_000 }, async () => {
  const runCase = async openResult => {
    const root = mkdtempSync(join(tmpdir(), 'board-one-use-ds-'))
    const run = join(root, 'run')
    const env = isolatedEnv(root, run)
    const progress = join(root, 'progress.md')
    const mockBoard = join(root, 'board.mjs')
    const pluginPath = join(root, 'deepseek-plugin.mjs')
    const hookScript = join(root, 'hook.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
    writeFileSync(hookScript, '// unused hook')
    const envAssign = Object.entries(env).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join('\n')
      + '\ndelete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;\n'
    writeFileSync(mockBoard, patchedBoardScript({ progress, openResult, envSetup: envAssign }))
    const source = deepseekLocalPlugin(process.execPath, hookScript, progress, env.HOME, mockBoard)
    writeFileSync(pluginPath, source)

    let failed = false
    try {
      const mod = await import(`${pathToFileURL(pluginPath).href}?t=${Math.random().toString(16).slice(2)}`)
      let registered = null
      const ctx = {
        on() {},
        inject(_deps, fn) {
          fn({ tools: { register(tool) { registered = tool } } })
        },
      }
      mod.apply(ctx)
      assert.ok(registered, 'registers agent_board tool')
      const reply = await registered.execute({ action: 'open' }, {})
      assert.doesNotMatch(reply.text, REUSABLE_LINK_RE)
      if (openResult) {
        assert.equal(reply.text, EN.boardPageWindowOpened)
        assert.doesNotMatch(reply.text, /http:\/\/127\.0\.0\.1/)
      } else {
        const match = OPEN_LINK_RE.exec(reply.text)
        assert.ok(match, `expected one-use link in tool reply: ${reply.text}`)
        assert.equal((await fetch(match[0])).status, 200)
        assert.equal((await fetch(match[0])).status, 403)
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        await closeRuntimeServers(run)
        await removeDir(root)
      } catch (cleanupError) {
        if (!failed) throw cleanupError
      }
    }
  }
  await runCase(true)
  await runCase(false)
})

test('Claude plugin liveBoardPage and showBoardPage omit links when a window opened and accept one-use links on fallback', () => {
  for (const s of [EN, ZH_TW, ZH_CN]) {
    assert.equal(typeof s.boardPageWindowOpened, 'string')
    assert.equal(typeof s.boardPageAlreadyOpen, 'string')
    assert.deepEqual(liveBoardPage(`${s.boardPageWindowOpened}\n`, s), { url: '', isKept: false, opened: 'window' })
    assert.deepEqual(liveBoardPage(`${s.serveKept}\n${s.boardPageAlreadyOpen}\n`, s), { url: '', isKept: true, opened: 'already' })
    const oneUse = 'http://127.0.0.1:45678/open/synthetic-one-use-code'
    assert.deepEqual(liveBoardPage(`${s.serveAt(oneUse)}\n`, s), { url: oneUse, isKept: false })
  }
})

test('kept silent server never falls back to printing the reusable ?t= address', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-silent-'))
  const run = join(root, 'run')
  const env = isolatedEnv(root, run)
  const progress = join(root, 'progress.md')
  const script = join(root, 'agent-board.mjs')
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  writeFileSync(script, patchedBoardScript({ progress, openResult: false }))

  const sockets = new Set()
  const silent = createNetServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
  })
  await new Promise(done => silent.listen(0, '127.0.0.1', done))
  const { port } = silent.address()

  const runtimeSubdir = process.platform === 'win32' ? join(run, 'agent-board') : run
  const addressFile = join(runtimeSubdir, `agent-board-${createHash('sha256').update(progress).digest('hex').slice(0, 16)}.json`)
  const stale = `http://127.0.0.1:${port}/?t=synthetic-quiet`
  const payload = JSON.stringify({ pid: process.pid, port, url: stale, path: progress, built: String(statSync(script).mtimeMs) })
  if (process.platform === 'win32') {
    privateRuntimeFolder(runtimeSubdir)
    writePrivateRuntimeFile(addressFile, payload)
  } else {
    writeFileSync(addressFile, payload, { mode: 0o600 })
  }

  let failed = false
  try {
    for (const args of [['--serve', '--no-open'], ['--html', '--no-open']]) {
      const res = await runCli(script, args, env)
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr}`)
      assert.ok(res.stdout.includes('already open is kept'), `${args.join(' ')} kept note:\n${res.stdout}`)
      assert.doesNotMatch(res.stdout, REUSABLE_LINK_RE)
      assert.equal(res.stdout.includes('synthetic-quiet'), false)
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      for (const socket of sockets) socket.destroy()
      await new Promise(done => silent.close(done))
      await removeDir(root)
    } catch (cleanupError) {
      if (!failed) throw cleanupError
    }
  }
})

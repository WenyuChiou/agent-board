import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

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
    assert.equal(firstGet.headers.get('set-cookie'), null, 'one-use open response sets no host-wide cookie')
    const html = await firstGet.text()
    assert.equal(html.includes(addressToken), false, 'page HTML never discloses the reusable address-file token')
    const pageSession = sessionFromHtml(html)

    const secondGet = await fetch(oneUseUrl)
    assert.equal(secondGet.status, 403, 'second GET to one-use link must be refused')

    const rootUrl = new URL('/', oneUseUrl)
    const reload = await fetch(rootUrl)
    assert.equal(reload.status, 200, 'bare GET / serves the static empty shell for sessionStorage reload')
    assert.equal(reload.headers.get('set-cookie'), null)
    const reloadHtml = await reload.text()
    assert.equal(reloadHtml.includes('id="page-session"'), false, 'bare GET / embeds no session secret')
    assert.equal(reloadHtml.includes(addressToken), false, 'bare GET / embeds no reusable token')

    const badRootHost = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: rootUrl.port, method: 'GET', path: '/', headers: { host: `evil.example:${rootUrl.port}` } }, res => {
        res.resume().on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(badRootHost, 421, 'bare GET / rejects invalid Host headers')

    assert.equal((await fetch(new URL('/?t=wrong', oneUseUrl))).status, 403, 'GET /?t=wrong is refused')
    assert.equal((await fetch(new URL('/api/board', oneUseUrl))).status, 403, 'API route without token is refused')
    assert.equal((await fetch(new URL('/api/board', oneUseUrl), { headers: { 'x-board-token': pageSession } })).status, 200, 'API route with redeemed pageSession succeeds')

    assert.equal((await fetch(serveOutUrl)).status, 200)
    assert.equal((await fetch(serveOutUrl)).status, 403)
  })
})

test('--no-open and SSH fallbacks print only a one-use link with no reusable token', { timeout: 30_000 }, async () => {
  await Promise.all([
    withCliFixture({ openResult: true }, async ({ env, script }) => {
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
    }),
    withCliFixture({ openResult: true }, async ({ env, script }) => {
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
      const res2 = await fetch(sshUrl2)
      assert.equal(res2.status, 200)
      assert.equal((await fetch(sshUrl2)).status, 403)

      // Make the remote browser visibly open, then run --serve over SSH: still prints a one-use link instead of "already open".
      const sshSession2 = sessionFromHtml(await res2.text())
      assert.equal((await fetch(new URL('/api/board', sshUrl2), {
        headers: { 'x-board-token': sshSession2, 'x-board-page': 'p-ssh-visible', 'x-board-visible': '1' },
      })).status, 200)
      const serveSshOpen = await runCli(script, ['--serve'], sshEnv)
      assert.equal(serveSshOpen.status, 0, serveSshOpen.stderr)
      assert.doesNotMatch(serveSshOpen.stdout, REUSABLE_LINK_RE)
      assert.equal(serveSshOpen.stdout.includes(EN.boardPageAlreadyOpen), false, serveSshOpen.stdout)
      const serveSshUrl = OPEN_LINK_RE.exec(serveSshOpen.stdout)?.[0]
      assert.ok(serveSshUrl && serveSshUrl !== sshUrl2, serveSshOpen.stdout)
      assert.ok(serveSshOpen.stdout.includes(EN.serveAt(serveSshUrl)), serveSshOpen.stdout)
      assert.equal((await fetch(serveSshUrl)).status, 200)
      assert.equal((await fetch(serveSshUrl)).status, 403)
    }),
  ])
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

    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      assert.equal((await fetch(oneUseUrl, { method })).status, 405, `${method} must be refused without consuming link`)
    }
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

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => fetch(oneUseUrl)))
    assert.deepEqual(concurrent.map(res => res.status).sort((x, y) => x - y), [200, 403, 403, 403, 403, 403, 403, 403])
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
    assert.equal((await fetch(openUrl)).status, 403, 'replaying the keyed /open/ link is refused')
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
  await Promise.all([runCase(true), runCase(false)])
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
  const runSilentCase = async args => {
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
      const res = await runCli(script, args, env)
      assert.equal(res.status, 1, `${args.join(' ')} must exit non-zero when kept server cannot mint link: ${res.stderr}`)
      assert.ok(res.stdout.includes(EN.serveKeptNoLink), `${args.join(' ')} actionable recovery note:\n${res.stdout}`)
      assert.equal(res.stdout.includes(EN.boardPageAlreadyOpen), false, `${args.join(' ')} must not say already open:\n${res.stdout}`)
      assert.equal(res.stdout.includes(EN.serveKept), false, `${args.join(' ')} must not print serveKept:\n${res.stdout}`)
      assert.equal(res.stdout.includes('already open'), false, `${args.join(' ')} must not claim page is already open:\n${res.stdout}`)
      assert.doesNotMatch(res.stdout, REUSABLE_LINK_RE)
      assert.equal(res.stdout.includes('synthetic-quiet'), false)
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
  }
  const runLegacyKeptCase = async args => {
    const root = mkdtempSync(join(tmpdir(), 'board-one-use-legacy-kept-'))
    const run = join(root, 'run')
    const env = isolatedEnv(root, run)
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
    writeFileSync(script, patchedBoardScript({ progress, openResult: false }))

    const legacy = createHttpServer((req, res) => {
      if (req.url === '/api/ping') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: progress, built: '0', pageAgo: null }))
        return
      }
      if (req.url === '/api/close') {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
    await new Promise(done => legacy.listen(0, '127.0.0.1', done))
    const { port } = legacy.address()

    const runtimeSubdir = process.platform === 'win32' ? join(run, 'agent-board') : run
    const addressFile = join(runtimeSubdir, `agent-board-${createHash('sha256').update(progress).digest('hex').slice(0, 16)}.json`)
    const stale = `http://127.0.0.1:${port}/?t=synthetic-quiet`
    const payload = JSON.stringify({ pid: process.pid, port, url: stale, path: progress, built: '0' })
    if (process.platform === 'win32') {
      privateRuntimeFolder(runtimeSubdir)
      writePrivateRuntimeFile(addressFile, payload)
    } else {
      writeFileSync(addressFile, payload, { mode: 0o600 })
    }

    let failed = false
    try {
      const res = await runCli(script, args, env)
      assert.equal(res.status, 1, `${args.join(' ')} must exit non-zero when legacy kept server cannot mint link: ${res.stderr}`)
      assert.ok(res.stdout.includes(EN.serveKeptNoLink), `${args.join(' ')} actionable recovery note:\n${res.stdout}`)
      assert.equal(res.stdout.includes(EN.boardPageAlreadyOpen), false, `${args.join(' ')} must not say already open:\n${res.stdout}`)
      assert.equal(res.stdout.includes(EN.serveKept), false, `${args.join(' ')} must not print serveKept:\n${res.stdout}`)
      assert.equal(res.stdout.includes('already open'), false, `${args.join(' ')} must not claim page is already open:\n${res.stdout}`)
      assert.doesNotMatch(res.stdout, REUSABLE_LINK_RE)
      assert.equal(res.stdout.includes('synthetic-quiet'), false)
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        await new Promise(done => legacy.close(done))
        await removeDir(root)
      } catch (cleanupError) {
        if (!failed) throw cleanupError
      }
    }
  }
  await Promise.all([
    runSilentCase(['--serve', '--no-open']),
    runSilentCase(['--html', '--no-open']),
    runLegacyKeptCase(['--serve']),
    runLegacyKeptCase(['--serve', '--no-open']),
    runLegacyKeptCase(['--html', '--no-open']),
  ])
})

test('replaying a keyed one-use open link after attacker pairs #k revokes the attacker secret and locks approvals off', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 200)
    const [openUrl, fragment] = board.opened[0].split('#')
    const pairKey = /^k=([\w-]+)$/.exec(fragment)?.[1]
    assert.ok(pairKey)

    const attackerGet = await fetch(openUrl)
    assert.equal(attackerGet.status, 200)
    const attackerSession = sessionFromHtml(await attackerGet.text())

    const asAttacker = (path, body, extra = {}) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': attackerSession,
        'x-board-page': 'p-attacker',
        origin: board.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const paired = await asAttacker('/api/approvals/pair', { key: pairKey })
    assert.equal(paired.status, 200)
    const { secret } = await paired.json()
    assert.ok(typeof secret === 'string' && secret.length > 0)

    // Real browser opens the stolen link second: 403 and approvals lock down immediately.
    const browserGet = await fetch(openUrl)
    assert.equal(browserGet.status, 403)

    const boardState = await (await asAttacker('/api/board')).json()
    assert.equal(boardState.approvals?.isLockdown, true, 'replay locks approvals off')
    const switchAfterReplay = await asAttacker('/api/approvals/switch', { enabled: false }, { 'x-board-approve': secret })
    assert.equal(switchAfterReplay.status, 403, 'attacker secret is revoked after open-link replay')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

const runServedPageInOrigin = async (html, pageUrl, originStores, { throwStorage = false } = {}) => {
  const nodes = new Map()
  const makeEl = tag => ({
    tag,
    childNodes: [],
    attributes: {},
    style: {},
    className: '',
    value: '',
    _text: '',
    set textContent(v) { this._text = v; if (v === '') this.childNodes = [] },
    get textContent() { return this._text },
    set id(v) { this.attributes.id = v; nodes.set(v, this) },
    get id() { return this.attributes.id ?? '' },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c },
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c) },
    insertBefore(c) { return this.appendChild(c) },
    insertAdjacentElement() {},
    remove() { this.parentNode?.removeChild(this) },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') nodes.set(v, this) },
    getAttribute(k) { return this.attributes[k] ?? null },
    addEventListener() {},
    querySelectorAll() { return [] },
    querySelector() { return makeEl('div') },
  })
  const mainEl = makeEl('main')
  const textOf = el => el.textContent + el.childNodes.map(textOf).join('')
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeEl('div'))
    return nodes.get(id)
  }
  const words = html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)
  if (words) get('words').textContent = words[1]
  const pageSessionTag = html.match(/<script[^>]*id="page-session"[^>]*>([\s\S]*?)<\/script>/)
  if (pageSessionTag) get('page-session').textContent = pageSessionTag[1]
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .find(code => code.includes('(function ()'))
  assert.ok(script, 'served HTML contains PAGE_SCRIPT')

  const url = new URL(pageUrl)
  if (!originStores.has(url.origin)) originStores.set(url.origin, new Map())
  const store = originStores.get(url.origin)
  const sessionStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  }
  let currentPath = url.pathname + url.search + url.hash
  let boardPollResolve
  let polled = false
  const firstBoardPoll = new Promise(resolve => { boardPollResolve = resolve })
  const document = {
    body: get('body'),
    getElementById: id => nodes.get(id) ?? get(id),
    createElement: makeEl,
    createTextNode: () => makeEl('text'),
    querySelector: selector => selector === 'main' ? mainEl : makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    title: '',
  }
  const vmContext = {
    document,
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: { replaceState: (_s, _t, next) => { currentPath = next } },
    URLSearchParams,
    crypto: { randomUUID },
    window: {},
    navigator: {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async (target, init = {}) => {
      const res = await fetch(new URL(target, url.origin), {
        ...init,
        headers: { ...(init.headers ?? {}), origin: url.origin },
      })
      if (String(target).startsWith('/api/board')) {
        polled = true
        boardPollResolve({ status: res.status, tokenSent: init.headers?.['x-board-token'] ?? '' })
      }
      return res
    },
  }
  if (throwStorage) {
    Object.defineProperty(vmContext, 'sessionStorage', {
      enumerable: true,
      configurable: true,
      get() { throw new Error('SecurityError') },
    })
  } else {
    vmContext.sessionStorage = sessionStorage
  }
  runInNewContext(script, vmContext, { timeout: 1000 })
  return {
    firstBoardPoll,
    polled: () => polled,
    currentPath: () => currentPath,
    offlineText: () => textOf(get('offline')),
    mainText: () => textOf(mainEl),
  }
}

test('two local boards on different ports issue no cookies, reload independently via origin-scoped sessionStorage, and reject each other sessions', { timeout: 25_000 }, async () => {
  const boardA = await startDirectBoard()
  const boardB = await startDirectBoard()
  let failed = false
  try {
    const linkA = (await boardA.call('/api/open-link', {})).body.url
    const linkB = (await boardB.call('/api/open-link', {})).body.url
    const resA = await fetch(linkA)
    const resB = await fetch(linkB)
    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)
    assert.equal(resA.headers.get('set-cookie'), null)
    assert.equal(resB.headers.get('set-cookie'), null)
    const htmlA = await resA.text()
    const htmlB = await resB.text()
    const sessionA = sessionFromHtml(htmlA)
    const sessionB = sessionFromHtml(htmlB)
    assert.notEqual(sessionA, sessionB)

    const originStores = new Map()
    const pageA1 = await runServedPageInOrigin(htmlA, linkA, originStores)
    assert.equal(pageA1.currentPath(), '/')
    assert.deepEqual(await pageA1.firstBoardPoll, { status: 200, tokenSent: sessionA })

    const pageB1 = await runServedPageInOrigin(htmlB, linkB, originStores)
    assert.equal(pageB1.currentPath(), '/')
    assert.deepEqual(await pageB1.firstBoardPoll, { status: 200, tokenSent: sessionB })

    // Opening B leaves A's origin-scoped session intact; reloading bare GET / on A still loads A's board.
    const reloadA = await fetch(new URL('/', boardA.origin))
    assert.equal(reloadA.status, 200)
    assert.equal(reloadA.headers.get('set-cookie'), null)
    const pageA2 = await runServedPageInOrigin(await reloadA.text(), `${boardA.origin}/`, originStores)
    assert.deepEqual(await pageA2.firstBoardPoll, { status: 200, tokenSent: sessionA })

    const reloadB = await fetch(new URL('/', boardB.origin))
    assert.equal(reloadB.status, 200)
    const pageB2 = await runServedPageInOrigin(await reloadB.text(), `${boardB.origin}/`, originStores)
    assert.deepEqual(await pageB2.firstBoardPoll, { status: 200, tokenSent: sessionB })

    // Also verify bare GET / does not bump pageAgo when no authenticated page asked yet.
    const boardC = await startDirectBoard()
    try {
      const beforeBare = await boardC.call('/api/ping')
      assert.equal(beforeBare.body.pageAgo, null)
      assert.equal((await fetch(new URL('/', boardC.origin))).status, 200)
      const afterBare = await boardC.call('/api/ping')
      assert.equal(afterBare.body.pageAgo, null, 'bare GET / shell reload does not count as an open page')
    } finally {
      await boardC.close()
    }

    // Sessions stay isolated per board server.
    assert.equal((await fetch(new URL('/api/board', boardA.origin), { headers: { 'x-board-token': sessionB } })).status, 403)
    assert.equal((await fetch(new URL('/api/board', boardB.origin), { headers: { 'x-board-token': sessionA } })).status, 403)

    // Throwing sessionStorage getter (strict privacy / sandboxed iframes) must not abort page boot.
    const blockedLink = (await boardA.call('/api/open-link', {})).body.url
    const blockedRes = await fetch(blockedLink)
    assert.equal(blockedRes.status, 200)
    const blockedHtml = await blockedRes.text()
    const blockedSession = sessionFromHtml(blockedHtml)
    const blockedPage = await runServedPageInOrigin(blockedHtml, blockedLink, originStores, { throwStorage: true })
    assert.equal(blockedPage.currentPath(), '/')
    assert.deepEqual(await blockedPage.firstBoardPoll, { status: 200, tokenSent: blockedSession })

    // Reloading bare GET / when sessionStorage is blocked shows session-lost guidance rather than offline.
    const blockedBare = await fetch(new URL('/', boardA.origin))
    assert.equal(blockedBare.status, 200)
    const blockedReload = await runServedPageInOrigin(await blockedBare.text(), `${boardA.origin}/`, originStores, { throwStorage: true })
    assert.equal(blockedReload.polled(), false, 'reload without token stops before polling with empty credentials')
    assert.equal(blockedReload.offlineText(), '')
    assert.ok(blockedReload.mainText().includes(EN.serveSessionLost))
    assert.equal(blockedReload.mainText().includes(EN.serveOffline), false)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await boardA.close() } catch (cleanupError) { if (!failed) throw cleanupError }
    try { await boardB.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

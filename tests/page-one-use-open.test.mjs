import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const { liveBoardArgv, liveBoardPage } = await import('../hooks/live-page.ts')
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
const LOCAL_ADDRESS_RE = /http:\/\/127\.0\.0\.1/
const SSH = { SSH_CONNECTION: '203.0.113.5 50000 203.0.113.9 2222', SSH_TTY: '/dev/pts/0' }
const SSH_TARGET = '-p 2222 203.0.113.9'
const LAN_URL = 'http://192.0.2.10:45678/?t=synthetic-lan'
const TTY_SHIM = 'process.stdout.isTTY = true; process.stdin.isTTY = true; process.stdin.setRawMode = () => process.stdin;\n'
const delay = ms => new Promise(done => setTimeout(done, ms))
// A terminal screen read as words: control codes become spaces, so a wrapped note reads as one line.
const flat = text => String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ' ').replace(/\s+/g, ' ')
const openLinksIn = text => [...String(text).matchAll(new RegExp(OPEN_LINK_RE.source, 'g'))].map(match => match[0])

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

// The board script with a stand-in browser: it notes each address it is handed, and with `redeem` it
// loads that address as a browser window would, which uses the one-use code the board gave it.
const patchedBoardScript = ({ progress, openResult, openLog, envSetup, redeem = false }) => {
  const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
  const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
  assert.ok(opening > 0 && opened > opening, 'locates openInBrowser in BOARD_SCRIPT')
  const logHook = openLog
    ? `process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(openLog)}, target + '\\n'); `
    : ''
  const load = redeem ? 'fetch(String(target).split("#")[0]).then(res => res.text()).catch(() => {}); ' : ''
  const envPatch = envSetup ? `${envSetup}\n` : ''
  const stub = `var openInBrowser = (target, done) => { if (isNoWindowHere()) return done(false); ${logHook}${load}done(${JSON.stringify(openResult)}) }\n`
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
      await delay(100)
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
      for (let i = 0; i < 40 && isAlive(record.pid); i++) await delay(100)
      if (isAlive(record.pid)) {
        try { process.kill(record.pid) } catch {}
        for (let i = 0; i < 20 && isAlive(record.pid); i++) await delay(100)
      }
    }
  }
}

const runCli = (script, args, env, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ status: error ? error.code : 0, stdout, stderr })
    })
  })

// The terminal board as an SSH login shows it: each step waits until the screen shows what it names,
// then presses its key. The whole output, stdout and stderr, comes back.
const driveWatch = async (script, env, shim, steps, waitMs = 20_000) => {
  const child = spawn(process.execPath, ['--require', shim, script, '--watch'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { out += String(chunk) })
  try {
    for (const step of steps) {
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !step.until(out)) await delay(50)
      assert.ok(step.until(out), `the terminal board never showed ${step.what}:\n${flat(out)}`)
      step.check?.(out)
      if (step.key) child.stdin.write(step.key)
    }
    child.stdin.write('q')
    await new Promise(done => {
      const timer = setTimeout(() => { try { child.kill() } catch {}; done() }, 3000)
      child.once('exit', () => { clearTimeout(timer); done() })
    })
    return out
  } finally {
    try { child.kill() } catch {}
  }
}

const withCliFixture = async ({ openResult = true, recordOpen = false, redeem = false, extraEnv = {} } = {}, runTest) => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-cli-'))
  const run = join(root, 'run')
  const env = isolatedEnv(root, run, extraEnv)
  const progress = join(root, 'progress.md')
  const openLog = recordOpen ? join(root, 'open-calls.log') : null
  const script = join(root, 'agent-board.mjs')
  const shim = join(root, 'tty-shim.cjs')
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  writeFileSync(script, patchedBoardScript({ progress, openResult, openLog, redeem }))
  writeFileSync(shim, TTY_SHIM)
  let failed = false
  try {
    await runTest({ root, run, env, progress, script, openLog, shim })
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

const writeAddressFile = (run, progress, payload) => {
  const runtimeSubdir = process.platform === 'win32' ? join(run, 'agent-board') : run
  const addressFile = join(runtimeSubdir, `agent-board-${createHash('sha256').update(progress).digest('hex').slice(0, 16)}.json`)
  if (process.platform === 'win32') {
    privateRuntimeFolder(runtimeSubdir)
    writePrivateRuntimeFile(addressFile, payload)
  } else {
    writeFileSync(addressFile, payload, { mode: 0o600 })
  }
}

// A page started by an older board that will not close (a reply may be on its way): it answers its
// ping, refuses to close, and has no route that makes a one-use link. With `lan` it still opens the
// page to the network, as main's board does.
const withLegacyBoard = async ({ openResult = false, recordOpen = false, lan = false } = {}, runTest) => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-legacy-'))
  const run = join(root, 'run')
  const env = isolatedEnv(root, run)
  const progress = join(root, 'progress.md')
  const script = join(root, 'agent-board.mjs')
  const shim = join(root, 'tty-shim.cjs')
  const openLog = recordOpen ? join(root, 'open-calls.log') : null
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  writeFileSync(script, patchedBoardScript({ progress, openResult, openLog }))
  writeFileSync(shim, TTY_SHIM)
  const legacy = createHttpServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/api/ping') return reply(200, { ok: true, path: progress, built: '0', pageAgo: null })
    if (req.url === '/api/close') return reply(409, { ok: false })
    if (lan && req.url === '/api/lan') return reply(200, { url: LAN_URL })
    reply(404, { ok: false })
  })
  await new Promise(done => legacy.listen(0, '127.0.0.1', done))
  const { port } = legacy.address()
  const stale = `http://127.0.0.1:${port}/?t=synthetic-quiet`
  writeAddressFile(run, progress, JSON.stringify({ pid: process.pid, port, url: stale, path: progress, built: '0' }))
  let failed = false
  try {
    await runTest({ env, script, shim, openLog, stale, port })
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      legacy.closeAllConnections?.()
      await new Promise(done => legacy.close(done))
      await removeDir(root)
    } catch (cleanupError) {
      if (!failed) throw cleanupError
    }
  }
}

const startDirectBoard = async ({ now, openLinkMs, open, openRedeemMs = 200, openLinkMax } = {}) => {
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
      openRedeemMs,
      ...(now === undefined ? {} : { now }),
      ...(openLinkMs === undefined ? {} : { openLinkMs }),
      ...(openLinkMax === undefined ? {} : { openLinkMax }),
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

// The command marks a page as visible, as a page in front does with each poll.
const markVisible = async (address, page = 'page-visible') => {
  const at = new URL(address)
  const res = await fetch(new URL('/api/board', at), { headers: { 'x-board-token': at.searchParams.get('t'), 'x-board-page': page, 'x-board-visible': '1' } })
  assert.equal(res.status, 200)
  await res.text()
}

const assertOneUse = async link => {
  assert.match(link, new RegExp(`^${OPEN_LINK_RE.source}$`))
  const first = await fetch(link)
  assert.equal(first.status, 200, `${link} opens once`)
  await first.text()
  const second = await fetch(link)
  assert.equal(second.status, 403, `${link} opens only once`)
  await second.text()
}

test('a window this run opened and the board saw redeemed prints no link', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true, redeem: true }, async ({ run, env, script, openLog }) => {
    for (const args of [['--html'], [], ['--serve']]) {
      const label = args.join(' ') || 'plain'
      const result = await runCli(script, args, env)
      assert.equal(result.status, 0, `${label}: ${result.stderr}`)
      assert.equal(result.stderr, '', label)
      assert.equal(result.stdout.trim(), EN.boardPageWindowOpened, `${label}: ${result.stdout}`)
      assert.doesNotMatch(result.stdout, /http|\/open\/|\?t=/)
      // The window used its code, so the address the browser holds opens nothing more.
      const handed = readFileSync(openLog, 'utf8').trim().split(/\r?\n/).at(-1)
      assert.match(handed, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+#k=[\w-]+$/)
      assert.equal((await fetch(handed.split('#')[0])).status, 403, label)
      assert.equal(findRecords(run).length, 1)
      // The page that window loaded now counts as open, so the next entry point starts from none.
      assert.equal((await runCli(script, ['--stop'], env)).status, 0, label)
    }
    assert.equal(readFileSync(openLog, 'utf8').trim().split(/\r?\n/).length, 3, 'one window for each run, since each window loaded its page')
  })
})

test('an opener that reports success with no redemption still prints a one-use link', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true }, async ({ env, script, openLog }) => {
    const serve = await runCli(script, ['--serve'], env)
    assert.equal(serve.status, 0, serve.stderr)
    const link = openLinksIn(serve.stdout).at(-1)
    assert.ok(link, serve.stdout)
    assert.equal(serve.stdout.trim().split(/\r?\n/).at(-1), EN.serveAt(link))
    assert.equal(serve.stderr.trim(), EN.boardPageLaunchedLink(link))
    assert.doesNotMatch(`${serve.stdout}${serve.stderr}`, REUSABLE_LINK_RE)
    assert.equal(serve.stdout.includes(EN.boardPageWindowOpened), false, 'a launcher that said yes is no proof of a window')
    const launched = readFileSync(openLog, 'utf8').trim().split(/\r?\n/)
    assert.equal(launched.length, 1)
    assert.notEqual(launched[0].split('#')[0], link, 'the printed link is a fresh one, not the one the browser was handed')

    const html = await runCli(script, ['--html'], env)
    assert.equal(html.status, 0, html.stderr)
    const htmlLink = openLinksIn(html.stdout).at(-1)
    assert.ok(htmlLink && htmlLink !== link, html.stdout)
    assert.equal(html.stdout.trim(), EN.boardPageLaunchedLink(htmlLink))
    // Opening a printed link loads the page, which then counts as open: these come last.
    await assertOneUse(link)
    await assertOneUse(htmlLink)
  })
})

test('already open always comes with a fresh one-use link', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true }, async ({ run, env, script, openLog }) => {
    const start = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(start.status, 0, start.stderr)
    const records = findRecords(run)
    assert.equal(records.length, 1)
    const seen = new Set()
    const fresh = link => {
      assert.ok(link && !seen.has(link), `a new link each time: ${link}`)
      seen.add(link)
      return link
    }

    await markVisible(records[0].url)
    const serve = await runCli(script, ['--serve'], env)
    assert.equal(serve.status, 0, serve.stderr)
    const serveLink = fresh(openLinksIn(serve.stdout).at(-1))
    assert.equal(serve.stdout.trim().split(/\r?\n/).at(-1), EN.serveAt(serveLink))
    assert.equal(serve.stderr.trim(), EN.boardPageAlreadyOpenLink(serveLink))

    await markVisible(records[0].url)
    const html = await runCli(script, ['--html'], env)
    assert.equal(html.status, 0, html.stderr)
    assert.equal(html.stderr, '')
    const htmlLink = fresh(openLinksIn(html.stdout).at(-1))
    assert.equal(html.stdout.trim(), EN.boardPageAlreadyOpenLink(htmlLink))

    await markVisible(records[0].url)
    const keys = await runCli(script, ['--keys', 'o'], env)
    assert.equal(keys.status, 0, keys.stderr)
    const keysLink = fresh(openLinksIn(keys.stdout).at(-1))
    assert.ok(flat(keys.stdout).includes(flat(EN.boardPageAlreadyOpenLink(keysLink))), keys.stdout)

    for (const out of [serve, html, keys]) {
      assert.doesNotMatch(`${out.stdout}${out.stderr}`, REUSABLE_LINK_RE)
      assert.equal(out.stdout.includes(EN.boardPageWindowOpened), false)
    }
    assert.equal(existsSync(openLog), false, 'no second window while one is open')
    for (const link of seen) await assertOneUse(link)
  })
})

test('a page that vanished since its last poll still leaves a link', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true }, async ({ run, env, script, openLog }) => {
    const start = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(start.status, 0, start.stderr)
    // The page asked a moment ago and then its browser crashed: it never said it was leaving.
    await markVisible(findRecords(run)[0].url, 'page-crashed')
    const serve = await runCli(script, ['--serve'], env)
    assert.equal(serve.status, 0, serve.stderr)
    const link = openLinksIn(serve.stdout).at(-1)
    assert.ok(link, serve.stdout)
    assert.equal(serve.stdout.trim().split(/\r?\n/).at(-1), EN.serveAt(link))
    assert.equal(serve.stderr.trim(), EN.boardPageAlreadyOpenLink(link))
    assert.doesNotMatch(`${serve.stdout}${serve.stderr}`, REUSABLE_LINK_RE)
    assert.equal(existsSync(openLog), false)
    await assertOneUse(link)
  })
})

test('--no-open prints only a one-use link', { timeout: 60_000 }, async () => {
  const runDeepseek = async () => {
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
    // A browser that would open and load the page: the model's tool still gets only the link.
    writeFileSync(mockBoard, patchedBoardScript({ progress, openResult: true, redeem: true, envSetup: envAssign }))
    writeFileSync(pluginPath, deepseekLocalPlugin(process.execPath, hookScript, progress, env.HOME, mockBoard))
    let failed = false
    try {
      const mod = await import(`${pathToFileURL(pluginPath).href}?t=${Math.random().toString(16).slice(2)}`)
      let registered = null
      mod.apply({ on() {}, inject(_deps, fn) { fn({ tools: { register(tool) { registered = tool } } }) } })
      assert.ok(registered, 'registers agent_board tool')
      const reply = await registered.execute({ action: 'open' }, {})
      assert.match(reply.text, new RegExp(`^${OPEN_LINK_RE.source}$`), `the tool answers with the link alone: ${reply.text}`)
      assert.doesNotMatch(readFileSync(progress, 'utf8'), LOCAL_ADDRESS_RE)
      await assertOneUse(reply.text)
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
  const runCommands = () => withCliFixture({ openResult: true, recordOpen: true, redeem: true }, async ({ run, env, script, openLog }) => {
    const serve = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(serve.status, 0, serve.stderr)
    assert.equal(serve.stderr, '')
    const serveLink = openLinksIn(serve.stdout).at(-1)
    assert.ok(serveLink, serve.stdout)
    assert.equal(serve.stdout.trim(), EN.serveAt(serveLink))
    // The plugin's own call for a model is this one, and it reads that line as the link.
    assert.ok(liveBoardArgv('agent-board.mjs', 'en', false).includes('--no-open'))
    assert.deepEqual(liveBoardPage(serve.stdout, EN), { url: serveLink, isKept: false })

    // A page in front does not turn --no-open into an "already open" claim.
    await markVisible(findRecords(run)[0].url)
    const html = await runCli(script, ['--html', '--no-open'], env)
    assert.equal(html.status, 0, html.stderr)
    assert.equal(html.stderr, '')
    const htmlLink = html.stdout.trim()
    assert.match(htmlLink, new RegExp(`^${OPEN_LINK_RE.source}$`))
    assert.notEqual(htmlLink, serveLink)
    assert.equal(existsSync(openLog), false, '--no-open launches nothing')
    await assertOneUse(serveLink)
    await assertOneUse(htmlLink)
  })
  await Promise.all([runDeepseek(), runCommands()])
})

test('over SSH every open prints a fresh one-use link', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: true, recordOpen: true, redeem: true }, async ({ run, env, script, openLog }) => {
    const start = await runCli(script, ['--serve', '--no-open'], env)
    assert.equal(start.status, 0, start.stderr)
    const records = findRecords(run)
    assert.equal(records.length, 1)
    const port = records[0].port
    const sshEnv = { ...env, ...SSH }
    const seen = new Set()
    const fresh = link => {
      assert.ok(link && !seen.has(link), `a new link each time: ${link}`)
      seen.add(link)
      return link
    }

    // A page open on the remote computer: the person at the SSH client still needs the forward and a link.
    await markVisible(records[0].url)
    const serve = await runCli(script, ['--serve'], sshEnv)
    assert.equal(serve.status, 0, serve.stderr)
    const serveLink = fresh(openLinksIn(serve.stdout).at(-1))
    assert.equal(serve.stdout.trim().split(/\r?\n/).at(-1), EN.serveAt(serveLink))
    assert.equal(serve.stderr.trim(), EN.serveSshHint(port, SSH_TARGET, serveLink))

    await markVisible(records[0].url)
    const html = await runCli(script, ['--html'], sshEnv)
    assert.equal(html.status, 0, html.stderr)
    const htmlLink = fresh(openLinksIn(html.stdout).at(-1))
    assert.deepEqual(html.stdout.trim().split(/\r?\n/), [EN.serveSshHint(port, SSH_TARGET, htmlLink), htmlLink])

    await markVisible(records[0].url)
    const keys = await runCli(script, ['--keys', 'o'], sshEnv)
    assert.equal(keys.status, 0, keys.stderr)
    const keysLink = fresh(openLinksIn(keys.stdout).at(-1))
    assert.ok(flat(keys.stdout).includes(flat(EN.serveSshHint(port, SSH_TARGET, keysLink))), keys.stdout)

    for (const out of [serve, html, keys]) {
      const all = `${out.stdout}${out.stderr}`
      assert.doesNotMatch(all, REUSABLE_LINK_RE)
      assert.equal(all.includes('already open'), false, all)
      assert.equal(all.includes(EN.boardPageWindowOpened), false, all)
    }
    assert.equal(existsSync(openLog), false, 'nothing is launched over SSH')
    for (const link of seen) await assertOneUse(link)
  })
})

test('the SSH watcher shows no stored link and o mints a new one', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: false }, async ({ run, env, script, shim }) => {
    const sshEnv = { ...env, ...SSH }
    let first = null
    let second = null
    // The hint stays on the screen as long as the board runs (minutes or hours), so it holds no link
    // that would be used up or expire meanwhile: each press of o makes its own.
    const out = await driveWatch(script, sshEnv, shim, [
      {
        what: 'the forward hint',
        until: text => text.includes('Forward port to open the page'),
        check: text => {
          const port = findRecords(run)[0]?.port
          assert.ok(port, 'the watcher started the page')
          assert.ok(flat(text).includes(flat(EN.serveSshForwardKey(port, SSH_TARGET))), flat(text))
          assert.deepEqual(openLinksIn(text), [], 'the hint holds no link')
        },
        key: 'o',
      },
      { what: 'a link after o', until: text => openLinksIn(text).length > 0, check: text => { first = openLinksIn(text).at(-1) }, key: 'o' },
      { what: 'a second link after o', until: text => openLinksIn(text).some(link => link !== first), check: text => { second = openLinksIn(text).find(link => link !== first) } },
    ])
    assert.ok(first && second && first !== second)
    assert.doesNotMatch(out, REUSABLE_LINK_RE)
    assert.equal(out.includes('already open'), false)
    await assertOneUse(first)
    await assertOneUse(second)
  })
})

test('a kept older server opens through the launcher and prints no token', { timeout: 60_000 }, async () => {
  await withLegacyBoard({ openResult: true, recordOpen: true }, async ({ env, script, openLog, stale }) => {
    const serve = await runCli(script, ['--serve'], env)
    assert.equal(serve.status, 0, serve.stderr)
    assert.deepEqual(serve.stdout.trim().split(/\r?\n/), [EN.serveKept, EN.boardPageWindowOpened])
    const html = await runCli(script, ['--html'], env)
    assert.equal(html.status, 0, html.stderr)
    assert.deepEqual(html.stdout.trim().split(/\r?\n/), [EN.serveKept, EN.boardPageWindowOpened])
    for (const out of [serve, html]) {
      const all = `${out.stdout}${out.stderr}`
      assert.doesNotMatch(all, LOCAL_ADDRESS_RE)
      assert.equal(all.includes('synthetic-quiet'), false)
    }
    // The older page's address goes only to the browser, as on main.
    assert.deepEqual(readFileSync(openLog, 'utf8').trim().split(/\r?\n/), [stale, stale])
  })
})

const assertRefused = (label, out, status, note) => {
  if (status !== undefined) assert.equal(status, 1, `${label} exits 1:\n${out}`)
  assert.ok(flat(out).includes(flat(note)), `${label} says what to do:\n${out}`)
  for (const claim of [EN.serveKept, EN.boardPageWindowOpened, EN.boardPageAlreadyOpen, 'already open']) {
    assert.equal(out.includes(claim), false, `${label} must not say ${claim}:\n${out}`)
  }
  assert.doesNotMatch(out, REUSABLE_LINK_RE)
  assert.doesNotMatch(out, OPEN_LINK_RE)
  assert.equal(out.includes('synthetic-quiet'), false)
}

test('a kept older server that cannot make a link refuses with the next step', { timeout: 90_000 }, async () => {
  await withLegacyBoard({ openResult: false, recordOpen: true }, async ({ env, script, shim, port }) => {
    const sshEnv = { ...env, ...SSH }
    const runs = [
      ['--serve (launcher fails)', ['--serve'], env],
      ['--html (launcher fails)', ['--html'], env],
      ['--serve --no-open', ['--serve', '--no-open'], env],
      ['--html --no-open', ['--html', '--no-open'], env],
      ['--serve over SSH', ['--serve'], sshEnv],
      ['--html over SSH', ['--html'], sshEnv],
    ]
    const [results, watched] = await Promise.all([
      Promise.all(runs.map(([, args, runEnv]) => runCli(script, args, runEnv))),
      driveWatch(script, sshEnv, shim, [
        { what: 'the forward hint', until: text => text.includes('Forward port to open the page'), check: text => assert.ok(flat(text).includes(flat(EN.serveSshForwardKey(port, SSH_TARGET))), flat(text)), key: 'o' },
        { what: 'the refusal after o', until: text => flat(text).includes(flat(EN.serveKeptNoLink)) },
      ]),
    ])
    results.forEach((result, index) => {
      const [label] = runs[index]
      assertRefused(label, `${result.stdout}${result.stderr}`, result.status, EN.serveKeptNoLink)
      assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), EN.serveKeptNoLink, label)
    })
    // The terminal board's screen gets the same exclusions as the commands' output.
    assertRefused('the SSH watcher', watched, undefined, EN.serveKeptNoLink)
  })
})

test('a failed link request says the same thing at every entry point', { timeout: 90_000 }, async () => {
  // A page of this very board that answers its ping but never answers for a link (a busy disk, a stuck
  // event loop): not an older page, so nothing about keeping one.
  const runBusy = () => withCliFixture({ extraEnv: { AGENT_BOARD_TEST_PID: String(process.pid) } }, async ({ run, env, progress, script, shim }) => {
    const held = new Set()
    const busy = createHttpServer((req, res) => {
      if (req.url === '/api/ping') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: progress, built: String(statSync(script).mtimeMs), allowResume: false, codexSend: true, pageAgo: null }))
        return
      }
      if (req.url === '/api/open-link') { held.add(res); return }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise(done => busy.listen(0, '127.0.0.1', done))
    const { port } = busy.address()
    writeAddressFile(run, progress, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/?t=synthetic-busy`, path: progress, built: String(statSync(script).mtimeMs) }))
    try {
      const sshEnv = { ...env, ...SSH }
      const runs = [['--serve', ['--serve']], ['--html', ['--html']], ['--keys o', ['--keys', 'o']]]
      const [results, watched] = await Promise.all([
        Promise.all(runs.map(([, args]) => runCli(script, args, env))),
        driveWatch(script, sshEnv, shim, [
          { what: 'the forward hint', until: text => text.includes('Forward port to open the page'), key: 'o' },
          { what: 'the busy note after o', until: text => flat(text).includes(flat(EN.serveBusy)) },
        ]),
      ])
      results.forEach((result, index) => {
        const [label] = runs[index]
        const all = `${result.stdout}${result.stderr}`
        assertRefused(label, all, result.status, EN.serveBusy)
        assert.equal(all.includes('synthetic-busy'), false)
        assert.equal(all.includes(EN.serveKeptNoLink), false, label)
        if (label !== '--keys o') assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), EN.serveBusy, label)
      })
      assertRefused('the SSH watcher', watched, undefined, EN.serveBusy)
    } finally {
      for (const res of held) res.destroy()
      busy.closeAllConnections?.()
      await new Promise(done => busy.close(done))
    }
  })
  // Something that takes the connection and says nothing at all, kept because its process still runs.
  const runSilent = () => withCliFixture({ extraEnv: { AGENT_BOARD_TEST_PID: String(process.pid) } }, async ({ run, env, progress, script }) => {
    const sockets = new Set()
    const silent = createNetServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
    })
    await new Promise(done => silent.listen(0, '127.0.0.1', done))
    const { port } = silent.address()
    writeAddressFile(run, progress, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/?t=synthetic-quiet`, path: progress, built: String(statSync(script).mtimeMs) }))
    try {
      const results = await Promise.all([runCli(script, ['--serve', '--no-open'], env), runCli(script, ['--html', '--no-open'], env)])
      for (const [index, result] of results.entries()) {
        const label = index === 0 ? '--serve --no-open (silent)' : '--html --no-open (silent)'
        assertRefused(label, `${result.stdout}${result.stderr}`, result.status, EN.serveBusy)
        assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), EN.serveBusy, label)
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(done => silent.close(done))
    }
  })
  await Promise.all([runBusy(), runSilent()])
})

test('a kept older server still hands the phone its LAN address', { timeout: 60_000 }, async () => {
  await withLegacyBoard({ lan: true }, async ({ env, script }) => {
    for (const args of [['--serve', '--lan', '--no-open'], ['--lan', '--no-open']]) {
      const label = args.join(' ')
      const result = await runCli(script, args, env)
      const all = `${result.stdout}${result.stderr}`
      assert.equal(result.status, 1, `${label}: ${all}`)
      assert.ok(result.stdout.includes(EN.serveKeptNoLink), `${label}: ${all}`)
      assert.ok(result.stdout.includes(EN.serveLanAt(LAN_URL)), `${label}: the phone still gets its address: ${all}`)
      assert.ok(result.stdout.includes(EN.serveLanWarn), label)
      assert.doesNotMatch(all, LOCAL_ADDRESS_RE, `${label}: nothing local to reuse`)
      assert.equal(all.includes('synthetic-quiet'), false, label)
      for (const claim of [EN.serveKept, EN.boardPageWindowOpened, EN.boardPageAlreadyOpen, 'already open']) assert.equal(all.includes(claim), false, `${label}: ${claim}`)
    }
  })
})

test('failed browser opener prints a one-use link whose second GET is refused', { timeout: 60_000 }, async () => {
  await withCliFixture({ openResult: false }, async ({ run, env, script }) => {
    const htmlRun = await runCli(script, ['--html'], env)
    assert.equal(htmlRun.status, 0, htmlRun.stderr)
    assert.equal(htmlRun.stderr, '')
    assert.doesNotMatch(htmlRun.stdout, REUSABLE_LINK_RE)
    const htmlMatch = OPEN_LINK_RE.exec(htmlRun.stdout)
    assert.ok(htmlMatch, `expected one-use link in stdout:\n${htmlRun.stdout}`)
    assert.equal(htmlRun.stdout.trim(), EN.serveBrowserNone(htmlMatch[0]))

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
    await secondGet.text()

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
    const target = new URL(oneUseUrl)
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: target.port, method: 'GET', path: target.pathname, headers: { host: `evil.example:${target.port}` } }, res => {
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

test('a link the command minted first still works when windows that never loaded fill the cap', { timeout: 20_000 }, async () => {
  // A cap of four stands for the board's 64: three keyed codes from windows that never loaded stay,
  // then a command mints its link, and its own window's code reaches the cap.
  const board = await startDirectBoard({ openLinkMax: 4, openRedeemMs: 0 })
  let failed = false
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await board.call('/api/open', { asApp: true })).body.isRedeemed, false)
    const fallback = (await board.call('/api/open-link', {})).body.url
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.body.isRedeemed, false, 'this window never loaded either')
    // The command now prints the link it minted first: it must still let the person in.
    const res = await fetch(fallback)
    assert.equal(res.status, 200, 'the printed link was pushed out by the window code minted after it')
    assert.equal((await res.text()).includes('id="page-session"'), true)
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

    const asPage = (path, body, extra = {}, sendOrigin = true) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': pageSession,
        'x-board-page': 'p-one-use',
        ...(sendOrigin ? { origin: board.origin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    for (const withOrigin of [false, true]) {
      assert.equal((await asPage('/api/board', undefined, {}, withOrigin)).status, 200)
      assert.equal((await asPage('/api/ping', undefined, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/open', { asApp: true }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/open-link', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/lan', { address: '' }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/package', { version: '9.9.9' }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/approvals/ask', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/messages/poll', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/messages/register', {}, {}, withOrigin)).status, 403)
    }

    // When /api/open's opener fails, the freshly minted unused open code is deleted immediately.
    const failingOpenBoard = await startDirectBoard({ open: async () => false })
    try {
      const failedOpened = await failingOpenBoard.call('/api/open', { asApp: true })
      assert.equal(failedOpened.status, 200)
      assert.equal(failingOpenBoard.opened.length, 1)
      const [failedOpenUrl] = failingOpenBoard.opened[0].split('#')
      assert.match(failedOpenUrl, OPEN_LINK_RE)
      assert.equal((await fetch(failedOpenUrl)).status, 403, 'failed /api/open deletes unused code immediately')
    } finally {
      await failingOpenBoard.close()
    }

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

test('Claude plugin liveBoardPage omits links when a window opened and accepts one-use links on fallback', () => {
  for (const s of [EN, ZH_TW, ZH_CN]) {
    assert.equal(typeof s.boardPageWindowOpened, 'string')
    assert.deepEqual(liveBoardPage(`${s.boardPageWindowOpened}\n`, s), { url: '', isKept: false, opened: 'window' })
    assert.deepEqual(liveBoardPage(`${s.serveKept}\n${s.boardPageWindowOpened}\n`, s), { url: '', isKept: true, opened: 'window' })
    // "Already open" never stands alone: the board always prints a link with it.
    assert.equal(liveBoardPage(`${s.boardPageAlreadyOpen}\n`, s), null)
    const oneUse = 'http://127.0.0.1:45678/open/synthetic-one-use-code'
    assert.deepEqual(liveBoardPage(`${s.serveAt(oneUse)}\n`, s), { url: oneUse, isKept: false })
  }
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

// Runs the page's own script against a fake document. Timers wait until the test runs them, so the
// test drives the page's poll; listeners are kept so the test can press a button.
const runServedPageInOrigin = async (html, pageUrl, originStores, { throwStorage = false } = {}) => {
  const nodes = new Map()
  const makeEl = tag => ({
    tag,
    childNodes: [],
    attributes: {},
    style: {},
    listeners: {},
    className: '',
    value: '',
    _text: '',
    set textContent(v) { this._text = v; if (v === '') this.childNodes = [] },
    get textContent() { return this._text },
    // The page script reads a shelf head's first child, its chevron (#1937).
    get firstChild() { return this.childNodes[0] ?? null },
    set id(v) { this.attributes.id = v; nodes.set(v, this) },
    get id() { return this.attributes.id ?? '' },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c },
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c) },
    insertBefore(c) { return this.appendChild(c) },
    insertAdjacentElement() {},
    remove() { this.parentNode?.removeChild(this) },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') nodes.set(v, this) },
    getAttribute(k) { return this.attributes[k] ?? null },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
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
    removeItem: key => store.delete(key),
  }
  let currentPath = url.pathname + url.search + url.hash
  let boardPollResolve
  const fetched = []
  const firstBoardPoll = new Promise(resolve => { boardPollResolve = resolve })
  const timers = new Map()
  let timerSeq = 0
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
    setTimeout: fn => { timerSeq += 1; timers.set(timerSeq, fn); return timerSeq },
    clearTimeout: id => { timers.delete(id) },
    fetch: async (target, init = {}) => {
      fetched.push(String(target))
      const res = await fetch(new URL(target, url.origin), {
        ...init,
        headers: { ...(init.headers ?? {}), origin: url.origin },
      })
      if (String(target).startsWith('/api/board')) boardPollResolve({ status: res.status, tokenSent: init.headers?.['x-board-token'] ?? '' })
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
    polled: () => fetched.some(path => path.startsWith('/api/board')),
    pollCount: () => fetched.filter(path => path.startsWith('/api/board')).length,
    fetched: () => [...fetched],
    // Runs every timer that is due by now, as the browser would once their delays pass.
    runTimers: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) { try { fn() } catch {} }
      return due.length
    },
    press: id => { for (const fn of get(id).listeners.click ?? []) fn({ preventDefault() {} }) },
    currentPath: () => currentPath,
    offlineText: () => textOf(get('offline')),
    mainText: () => textOf(mainEl),
  }
}

const waitUntil = async (isDone, what, waitMs = 3_000) => {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && !isDone()) await delay(20)
  assert.ok(isDone(), what)
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
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await boardA.close() } catch (cleanupError) { if (!failed) throw cleanupError }
    try { await boardB.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

const assertSessionLostScreen = (page, store, label) => {
  assert.ok(page.mainText().includes(EN.serveSessionLost), `${label}: ${page.mainText()}`)
  assert.equal(page.offlineText(), '', `${label}: not the offline banner`)
  assert.equal(page.mainText().includes(EN.serveOffline), false, label)
  assert.equal(store.get('agent_board_session'), undefined, `${label}: the session leaves the tab's storage`)
}

test('a used or expired link shows how to get a new one', { timeout: 25_000 }, async () => {
  let clock = 1_000_000
  const board = await startDirectBoard({ now: () => clock, openLinkMs: 5_000 })
  let failed = false
  try {
    const used = (await board.call('/api/open-link', {})).body.url
    assert.equal((await (await fetch(used)).text()).includes('id="page-session"'), true)
    const expired = (await board.call('/api/open-link', {})).body.url
    clock += 6_000
    const unknown = `${board.origin}/open/${'x'.repeat(32)}`
    // A keyed link a stranger used first: the person's own window gets the same page, and approvals go off.
    const keyed = await board.call('/api/open', { asApp: true })
    assert.equal(keyed.status, 200)
    const [keyedUrl] = board.opened[0].split('#')
    assert.equal((await (await fetch(keyedUrl)).text()).includes('id="page-session"'), true)

    for (const [label, link] of [['a used link', used], ['an expired link', expired], ['an unknown link', unknown], ['a keyed link opened twice', keyedUrl]]) {
      const res = await fetch(link)
      assert.equal(res.status, 403, label)
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/, `${label}: a page, not a bare {}`)
      const html = await res.text()
      assert.equal(html.includes('id="page-session"'), false, `${label}: no session in it`)
      assert.equal(html.includes(board.token), false, label)
      const store = new Map()
      const page = await runServedPageInOrigin(html, link, new Map([[board.origin, store]]))
      await waitUntil(() => page.mainText().includes(EN.serveSessionLost), `${label}: ${page.mainText()}`)
      assertSessionLostScreen(page, store, label)
      assert.equal(page.polled(), false, `${label}: nothing to poll with`)
      assert.equal(page.currentPath(), '/', `${label}: the dead code leaves the address bar`)
    }
    // The same used link opened in a tab that still holds a live session (one from scrollback pasted
    // into the board's own tab): the same screen, and the tab's session ends with it.
    const live = (await board.call('/api/open-link', {})).body.url
    const tab = new Map()
    const first = await runServedPageInOrigin(await (await fetch(live)).text(), live, new Map([[board.origin, tab]]))
    assert.equal((await first.firstBoardPoll).status, 200, 'the tab is signed in first')
    assert.ok(tab.get('agent_board_session'), 'the tab keeps its session')
    const again = await runServedPageInOrigin(await (await fetch(used)).text(), used, new Map([[board.origin, tab]]))
    await waitUntil(() => again.mainText().includes(EN.serveSessionLost), `a used link in a signed-in tab: ${again.mainText()}`)
    assertSessionLostScreen(again, tab, 'a used link in a signed-in tab')
    assert.equal(again.polled(), false, 'a used link in a signed-in tab: no poll with the old session')
    const ping = await board.call('/api/board')
    assert.equal(ping.body.approvals?.isLockdown, true, 'the second use of a keyed link still turns approvals off')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('any rejected page call ends in the session-lost screen', { timeout: 30_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const openPage = async () => {
      const link = (await board.call('/api/open-link', {})).body.url
      const res = await fetch(link)
      const html = await res.text()
      const store = new Map()
      const page = await runServedPageInOrigin(html, link, new Map([[board.origin, store]]))
      assert.equal((await page.firstBoardPoll).status, 200)
      return { page, store }
    }
    const polling = await openPage()
    const pressing = await openPage()
    // The board forgets both pages' sessions on its own while it keeps running: 64 newer pages push them
    // out of the sessions it keeps.
    for (let index = 0; index < 64; index += 1) {
      const link = (await board.call('/api/open-link', {})).body.url
      await (await fetch(link)).text()
    }

    // A poll: the page's next scheduled refresh meets the rejection.
    const before = polling.page.pollCount()
    await waitUntil(() => { polling.page.runTimers(); return polling.page.pollCount() > before }, 'the page polls again when its timer runs')
    await waitUntil(() => polling.page.mainText().includes(EN.serveSessionLost), `the poll ends in the session-lost screen: ${polling.page.mainText()}`)
    assertSessionLostScreen(polling.page, polling.store, 'a poll')
    const polls = polling.page.pollCount()
    for (let round = 0; round < 5; round += 1) { polling.page.runTimers(); await delay(20) }
    assert.equal(polling.page.pollCount(), polls, 'polling stops for good')

    // A press: the page's own close button is the call that meets the rejection.
    const fetchedBefore = pressing.page.fetched().length
    const pollsBeforePress = pressing.page.pollCount()
    pressing.page.press('close')
    await waitUntil(() => pressing.page.fetched().slice(fetchedBefore).includes('/api/close'), 'the press reaches the board')
    await waitUntil(() => pressing.page.mainText().includes(EN.serveSessionLost), `the press ends in the session-lost screen: ${pressing.page.mainText()}`)
    assertSessionLostScreen(pressing.page, pressing.store, 'a press')
    // The press's own answer ends the page: no poll is needed to find out, so none follows it.
    assert.equal(pressing.page.pollCount(), pollsBeforePress, `the press alone decides: ${pressing.page.fetched().slice(fetchedBefore)}`)
    const pressPolls = pressing.page.pollCount()
    for (let round = 0; round < 5; round += 1) { pressing.page.runTimers(); await delay(20) }
    assert.equal(pressing.page.pollCount(), pressPolls, 'no poll after the press either')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a reload with storage blocked asks for a fresh link', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const link = (await board.call('/api/open-link', {})).body.url
    const html = await (await fetch(link)).text()
    const stores = new Map()
    const opened = await runServedPageInOrigin(html, link, stores, { throwStorage: true })
    assert.equal((await opened.firstBoardPoll).status, 200, 'the first load works without storage')

    const bare = await fetch(new URL('/', board.origin))
    assert.equal(bare.status, 200)
    const shell = await bare.text()
    assert.equal(shell.includes('id="page-session"'), false, 'the bare shell holds no session')
    const reload = await runServedPageInOrigin(shell, `${board.origin}/`, stores, { throwStorage: true })
    await waitUntil(() => reload.mainText().includes(EN.serveSessionLost), `the reload asks for a fresh link: ${reload.mainText()}`)
    assert.equal(reload.polled(), false, 'no poll with an empty credential')
    assert.equal(reload.offlineText(), '')
    assert.equal(reload.mainText().includes(EN.serveOffline), false)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

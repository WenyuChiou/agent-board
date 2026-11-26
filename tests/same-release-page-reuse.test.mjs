import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bundleFromDir } from '../scripts/bundle-text.mjs'

// Acceptance tests for #1831: two copies of the same release with different mtimes/preludes/CRLF
// reuse the running board page, while different script bytes (even with equal mtime) or different
// launch options replace it cleanly.
const BOARD_SCRIPT = bundleFromDir(new URL('..', import.meta.url))
const SAMPLE_BOARD = `# Progress

## sample-api
<!-- auto session=c0ffee12 agent=codex state=working updated=2026-11-26T00:00:00Z -->
### Synthetic work item
- [~] In progress
<!-- /auto session=c0ffee12 -->
`

const servedAt = (run, boardPath) => join(
  process.platform === 'win32' ? join(run, 'agent-board') : run,
  `agent-board-${createHash('sha256').update(boardPath).digest('hex').slice(0, 16)}.json`,
)

const isAlive = pid => {
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const requestJson = (url, method, reqPath, headers = {}, body = undefined) => new Promise((resolve, reject) => {
  const { port, searchParams } = new URL(url)
  const req = request({
    host: '127.0.0.1', port, method, path: reqPath,
    headers: { host: `127.0.0.1:${port}`, 'x-board-token': searchParams.get('t'), ...headers },
  }, res => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { raw += chunk })
    res.on('end', () => {
      try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || '{}') }) }
      catch (err) { reject(err) }
    })
  })
  req.on('error', reject)
  req.setTimeout(5000, () => req.destroy(new Error(`request timed out: ${method} ${reqPath}`)))
  req.end(body)
})

const createBoardFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-same-release-'))
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  if (process.platform === 'win32') mkdirSync(join(run, 'agent-board'))
  const boardPath = join(dir, 'progress.md')
  writeFileSync(boardPath, SAMPLE_BOARD)
  const home = join(dir, 'home')
  const temp = join(dir, 'tmp')
  mkdirSync(home)
  mkdirSync(temp)
  const machine = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec']
  const env = {
    ...Object.fromEntries(machine.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: run,
    AGENT_BOARD_TEST_PID: String(process.pid),
  }
  const served = servedAt(run, boardPath)
  const writeCopy = (name, prelude, body, mtimeDate, crlf = false) => {
    const file = join(dir, name)
    const header = prelude === null ? '' : `globalThis.AGENT_BOARD = ${JSON.stringify(prelude)}\n`
    const content = crlf ? `${header}${body}`.replace(/\r?\n/g, '\r\n') : `${header}${body}`
    writeFileSync(file, content)
    utimesSync(file, mtimeDate, mtimeDate)
    return file
  }
  const serve = (scriptFile, extra = []) => new Promise((done, fail) => {
    execFile(process.execPath, [scriptFile, '--serve', '--no-open', ...extra], { env, encoding: 'utf8', timeout: 20_000 }, (error, out, err) => {
      if (error) return fail(new Error(`${error.message}\nstdout: ${out}\nstderr: ${err}`))
      done(out)
    })
  })
  const urlOf = out => out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0] ?? null
  const pingOf = async url => (await requestJson(url, 'GET', '/api/ping')).json
  const boardPoll = (url, pageId) => requestJson(url, 'GET', '/api/board', { 'x-board-page': pageId, 'x-board-visible': '1' })
  const end = async urls => {
    const record = existsSync(served) ? JSON.parse(readFileSync(served, 'utf8')) : null
    const pid = record?.pid ?? null
    for (const url of new Set([...urls, record?.url].filter(Boolean))) {
      await requestJson(url, 'POST', '/api/close', { 'content-type': 'application/json' }, '{}').catch(() => {})
    }
    for (let tries = 0; existsSync(served) && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
    for (let tries = 0; isAlive(pid) && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
  }
  return { dir, home, boardPath, served, writeCopy, serve, urlOf, pingOf, boardPoll, end }
}

test('two copies of the same release with different mtimes, preludes, and line endings reuse the running page (#1831)', { timeout: 60_000 }, async () => {
  const board = createBoardFixture()
  const urls = []
  try {
    const t1 = new Date('2026-11-26T01:00:00Z')
    const t2 = new Date('2026-11-26T01:05:00Z')
    const t3 = new Date('2026-11-26T01:10:00Z')
    const pluginCopy = board.writeCopy('plugin-copy.mjs', { path: board.boardPath, lang: 'en', hookVersion: 1 }, BOARD_SCRIPT, t1)
    const standaloneCopy = board.writeCopy('standalone-copy.mjs', { path: board.boardPath, lang: 'en', codexRoot: board.home }, BOARD_SCRIPT, t2, true)
    const rawCopy = board.writeCopy('raw-copy.mjs', null, BOARD_SCRIPT, t3)

    const url1 = board.urlOf(await board.serve(pluginCopy, ['--quiet-board']))
    assert.ok(url1)
    urls.push(url1)
    const pid1 = JSON.parse(readFileSync(board.served, 'utf8')).pid

    const url2 = board.urlOf(await board.serve(standaloneCopy, ['--quiet-board']))
    assert.equal(url2, url1, 'standalone copy with different mtime/prelude/CRLF must reuse the plugin page')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).pid, pid1)

    const url3 = board.urlOf(await board.serve(rawCopy, ['--quiet-board', '--progress-file', board.boardPath]))
    assert.equal(url3, url1, 'raw copy without AGENT_BOARD prelude must reuse the same-release page')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).pid, pid1)
  } finally {
    await board.end(urls)
  }
})

test('a copy with different script bytes and the same mtime replaces the running page and notifies open tabs (#1831)', { timeout: 60_000 }, async () => {
  const board = createBoardFixture()
  const urls = []
  try {
    const sameTime = new Date('2026-11-26T02:00:00Z')
    const copyA = board.writeCopy('release-a.mjs', { path: board.boardPath, lang: 'en' }, BOARD_SCRIPT, sameTime)
    const copyB = board.writeCopy('release-b.mjs', { path: board.boardPath, lang: 'en' }, `${BOARD_SCRIPT}\n// synthetic-next-release\n`, sameTime)

    const first = board.urlOf(await board.serve(copyA, ['--quiet-board']))
    assert.ok(first)
    urls.push(first)

    const initialPoll = await board.boardPoll(first, 'tab-1')
    assert.equal(initialPoll.status, 200)
    assert.ok(initialPoll.json.model)

    const second = board.urlOf(await board.serve(copyB, ['--quiet-board']))
    assert.ok(second)
    assert.notEqual(second, first, 'different script bytes must replace the running page even when mtimes match')
    urls.push(second)

    const moved = await board.boardPoll(first, 'tab-1')
    assert.equal(moved.status, 200)
    assert.deepEqual(moved.json, { moved: true })
  } finally {
    await board.end(urls)
  }
})

test('same-release copies still replace the running page when launch options differ and preserve --no-codex-send (#1831)', { timeout: 60_000 }, async () => {
  const board = createBoardFixture()
  const urls = []
  try {
    const copyA = board.writeCopy('copy-a.mjs', { path: board.boardPath, lang: 'en' }, BOARD_SCRIPT, new Date('2026-11-26T03:00:00Z'))
    const copyB = board.writeCopy('copy-b.mjs', { path: board.boardPath, lang: 'en', codexRoot: board.home }, BOARD_SCRIPT, new Date('2026-11-26T03:05:00Z'))

    const url1 = board.urlOf(await board.serve(copyA, ['--quiet-board']))
    assert.ok(url1)
    urls.push(url1)
    assert.equal((await board.pingOf(url1)).codexSend, true)

    assert.equal(board.urlOf(await board.serve(copyB, ['--quiet-board'])), url1)

    const url2 = board.urlOf(await board.serve(copyB, ['--quiet-board', '--no-codex-send']))
    assert.ok(url2)
    assert.notEqual(url2, url1)
    urls.push(url2)
    assert.equal((await board.pingOf(url2)).codexSend, false)

    assert.equal(board.urlOf(await board.serve(copyA, ['--quiet-board'])), url2, 'plain command from another copy keeps --no-codex-send page')

    const url3 = board.urlOf(await board.serve(copyA, ['--quiet-board', '--allow-resume']))
    assert.ok(url3)
    assert.notEqual(url3, url2)
    urls.push(url3)
    const ping3 = await board.pingOf(url3)
    assert.equal(ping3.allowResume, true)
    assert.equal(ping3.codexSend, false)
  } finally {
    await board.end(urls)
  }
})

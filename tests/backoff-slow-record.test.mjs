import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bundleFromDir } from '../scripts/bundle-text.mjs'
import { privateRuntimeFolder, writePrivateRuntimeFile } from '../scripts/runtime-folder.ts'
import { EN } from '../hooks/strings-en.ts'
import { readPrintedLink } from './helpers/printed-link.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

const save = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const makeBox = () => {
  const box = mkdtempSync(join(tmpdir(), 'agent-board-backoff-'))
  const home = join(box, 'home')
  const tmp = join(box, 'tmp')
  for (const dir of [home, tmp]) mkdirSync(dir)
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp,
    CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: join(tmp, 'run'),
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    LANG: 'en_US.UTF-8', NO_COLOR: '1', npm_config_update_notifier: 'false',
    AGENT_BOARD_TEST_PID: String(process.pid),
  }
  const cleanup = () => {
    try { rmSync(box, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }) } catch {}
  }
  return { box, home, tmp, env, cleanup }
}

const asyncFixture = async fn => {
  const f = makeBox()
  try { return await fn(f) }
  finally { f.cleanup() }
}

let packedPaths
const packed = f => {
  if (!packedPaths) {
    const out = spawnSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: repo, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 60000, shell: true,
    })
    assert.ifError(out.error)
    assert.equal(out.status, 0, out.stderr)
    packedPaths = JSON.parse(out.stdout)[0].files.map(file => file.path)
  }
  const pkg = join(f.box, 'package')
  for (const rel of packedPaths) {
    const dest = join(pkg, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(repo, rel), dest)
  }
  return pkg
}

test('launcher waits for a slow 0-byte address record after claim backoff and reuses the server without starting a second child', { timeout: 120_000 }, async () => {
  await asyncFixture(async f => {
    const pkg = packed(f)
    const boardScript = join(f.home, '.agent-board/agent-board.mjs')
    const progressPath = join(f.home, '.agent-board/progress.md')
    const prelude = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progressPath, lang: 'en', codexRoot: dirname(boardScript) })}\n`
    save(boardScript, `${prelude}${bundleFromDir(pkg)}`)
    save(progressPath, '# Progress\n')

    const runDir = join(f.tmp, 'run')
    mkdirSync(runDir, { mode: 0o700 })
    const recordDir = process.platform === 'win32' ? join(runDir, 'agent-board') : runDir
    mkdirSync(recordDir, { mode: 0o700, recursive: true })
    if (process.platform === 'win32') privateRuntimeFolder(recordDir)
    const recordName = `agent-board-${createHash('sha256').update(resolve(progressPath)).digest('hex').slice(0, 16)}.json`
    const recordPath = join(recordDir, recordName)
    const stagedPath = join(recordDir, `staged-${recordName}`)
    const messagesDir = recordPath.replace(/\.json$/, '-messages')
    mkdirSync(messagesDir, { mode: 0o700, recursive: true })
    const rawScript = readFileSync(boardScript, 'utf8')
    const cut = rawScript.indexOf('\n')
    const built = createHash('sha256').update((rawScript.startsWith('globalThis.AGENT_BOARD = ') ? (cut >= 0 ? rawScript.slice(cut + 1) : '') : rawScript).replace(/\r\n/g, '\n')).digest('hex')

    const nonce = randomBytes(16).toString('hex')
    const claimName = `.message-claim-${process.pid}-${nonce}.json`
    writeFileSync(join(messagesDir, claimName), `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`, { mode: 0o600 })

    const posts = []
    const linkTokens = []
    let answerPing = false
    const sockets = new Set()
    const fake = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        if (!answerPing) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: resolve(progressPath), built, allowResume: false, codexSend: true, messagesDirectory: resolve(messagesDir) }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/package') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try { posts.push(JSON.parse(body)) } catch { posts.push(null) }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
        return
      }
      // #1650: the launcher asks the running board for a one-use link, with the record's token.
      if (req.method === 'POST' && url.pathname === '/api/open-link') {
        linkTokens.push(req.headers['x-board-token'] ?? null)
        req.resume()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/open/slowrecordlink` }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/close') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })
    fake.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise(done => fake.listen(0, '127.0.0.1', done))
    const port = fake.address().port
    const fakeUrl = `http://127.0.0.1:${port}/?t=slowrecordtoken`
    const writeRecord = file => {
      const text = JSON.stringify({ pid: 2147483647, port, url: fakeUrl, path: resolve(progressPath), built })
      if (process.platform === 'win32') writePrivateRuntimeFile(file, text)
      else writeFileSync(file, text, { mode: 0o600 })
    }
    const sleep = ms => new Promise(done => setTimeout(done, ms))
    const waitFor = async (check, timeoutMs, what) => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        if (check()) return
        await sleep(5)
      }
      throw new Error(`timed out waiting for ${what}`)
    }

    const baselineMtime = statSync(messagesDir).mtimeMs
    const childClaimed = () => {
      try {
        if (statSync(messagesDir).mtimeMs !== baselineMtime) return true
        return readdirSync(messagesDir).some(name => name.startsWith('.message-claim-') && name !== claimName)
      } catch { return false }
    }

    let claimCreates = 0
    let watcher = null
    try {
      watcher = watch(messagesDir, (event, filename) => {
        if (event !== 'rename' || typeof filename !== 'string' || !filename.startsWith('.message-claim-') || filename === claimName) return
        try { if (existsSync(join(messagesDir, filename))) claimCreates++ } catch {}
      })
    } catch {}

    let launcher = null
    const runLauncher = () => new Promise((resolvePromise, rejectPromise) => {
      launcher = spawn(process.execPath, [join(pkg, 'bin/agent-board.mjs')], { cwd: f.box, env: { ...f.env, CI: '0' }, windowsHide: true })
      let stdout = ''
      let stderr = ''
      launcher.stdout.setEncoding('utf8')
      launcher.stdout.on('data', chunk => { stdout += chunk })
      launcher.stderr.setEncoding('utf8')
      launcher.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => {
        launcher.kill()
        rejectPromise(new Error(`the launcher did not exit in time: ${stderr}`))
      }, 25000)
      launcher.once('error', error => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      launcher.once('close', code => {
        clearTimeout(timer)
        resolvePromise({ code, stdout, stderr })
      })
    })

    try {
      // Pre-stage a valid private record so atomic rename takes < 1 ms after the slow 0-byte delay.
      writeRecord(stagedPath)
      const before = claimCreates
      const run = runLauncher()
      await waitFor(childClaimed, 15000, 'the launcher child to claim the message store')
      await sleep(500)
      writeRecord(recordPath)
      await waitFor(() => !existsSync(recordPath), 15000, 'the wait loop to delete the address record')
      // Write a 0-byte reservation as writePrivateRuntimeFile does before ACL checks finish, hold it past the 50-200 ms backoff, then publish.
      writeFileSync(recordPath, '', { mode: 0o600 })
      answerPing = true
      await sleep(500)
      renameSync(stagedPath, recordPath)

      const result = await run
      assert.equal(result.code, 0, result.stderr)
      // The reused server's one-use link is printed, never the page's token (#1650).
      // The plain command (no --serve) prints the bare link as its last line; the stand-in's code is
      // shorter than a real one, so the link is named in full.
      readPrintedLink({ stdout: result.stdout, stderr: result.stderr }, { wordings: [EN.boardPageLink], expected: `http://127.0.0.1:${port}/open/slowrecordlink`, secrets: ['slowrecordtoken'] })
      assert.ok(linkTokens.length >= 1 && linkTokens.every(token => token === 'slowrecordtoken'), JSON.stringify(linkTokens))
      assert.equal(posts.length, 1, JSON.stringify(posts))
      assert.equal(posts[0]?.version, manifest.version)
      assert.ok(claimCreates - before <= 1, `the launcher started ${claimCreates - before} children in the slow 0-byte backoff scenario`)
    } finally {
      if (launcher !== null && launcher.exitCode === null) launcher.kill()
      watcher?.close()
      for (const socket of sockets) socket.destroy()
      await new Promise(done => fake.close(done))
    }
  })
})

test('launcher retries immediately after claim backoff when no address record exists', async () => {
  const { waitForPublishedRecord } = await import('../scripts/backoff-publish.ts')
  await asyncFixture(async f => {
    const missing = join(f.tmp, 'missing-record.json')
    let calls = 0
    const started = performance.now()
    const found = await waitForPublishedRecord(missing, async () => {
      calls++
      return null
    }, started + 5000, 500, 20)
    const elapsed = performance.now() - started
    assert.equal(found, null)
    assert.equal(calls, 1)
    assert.ok(elapsed < 200, `expected immediate return, took ${elapsed} ms`)
  })
})

test('launcher stops waiting after claim backoff when a 0-byte address record stays empty past the publish deadline', async () => {
  const { waitForPublishedRecord } = await import('../scripts/backoff-publish.ts')
  await asyncFixture(async f => {
    const empty = join(f.tmp, 'empty-record.json')
    writeFileSync(empty, '')
    let calls = 0
    const started = performance.now()
    const found = await waitForPublishedRecord(empty, async () => {
      calls++
      return null
    }, started + 5000, 120, 20)
    const elapsed = performance.now() - started
    assert.equal(found, null)
    assert.equal(calls, 0)
    assert.ok(elapsed >= 90 && elapsed < 1000, `expected bounded publish wait near 120 ms, took ${elapsed} ms`)
  })
})

test('launcher retries immediately after claim backoff when a non-empty corrupt address record sits on disk', async () => {
  const { waitForPublishedRecord } = await import('../scripts/backoff-publish.ts')
  await asyncFixture(async f => {
    const corrupt = join(f.tmp, 'corrupt-record.json')
    writeFileSync(corrupt, '{broken')
    let calls = 0
    const started = performance.now()
    const found = await waitForPublishedRecord(corrupt, async () => {
      calls++
      return null
    }, started + 5000, 500, 20)
    const elapsed = performance.now() - started
    assert.equal(found, null)
    assert.equal(calls, 1)
    assert.ok(elapsed < 200, `expected immediate return, took ${elapsed} ms`)
  })
})

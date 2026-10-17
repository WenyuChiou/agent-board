// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const FILE = `# Progress

## api-gateway
<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=2026-10-17T08:30:00Z -->
### Rate-limit the public endpoints
- [x] Added the token bucket middleware
- [?] Per-key limit — 100 or 300 a minute?
<!-- /auto session=a1b2c3d4 -->
`

const run = (lang, args = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, FILE)
    mkdirSync(join(dir, 'progress-inbox'))
    writeFileSync(join(dir, 'progress-inbox', 'gemini-turn-1-1.json'), JSON.stringify({ session_id: 'g1', cwd: join(dir, 'docs-site'), prompt_response: 'Fixed 12 broken links.' }))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    return execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the board script prints the board from the file it was written for, in its language', () => {
  const text = run('en')
  assert.ok(text.startsWith('Progress  ● 1 waiting'), text)
  assert.ok(text.includes('api-gateway · codex › Rate-limit the public endpoints'), text)
  assert.ok(text.includes('docs-site · gemini: Fixed 12 broken links.'), text)
  assert.ok(run('zh-TW').startsWith('進度  ● 1 等你'))
  assert.ok(run('en', ['--lang', 'zh-CN']).startsWith('进度'))
})

test('keys played on the board tick a hand-kept step, archive a stopped block, and leave a line in the journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, `${FILE}
## Job search
### Fabrikam fellowship
- [x] Draft the statement
- [ ] Ask two referees

## docs-site
<!-- auto session=b2c3d4e5 agent=gemini state=ended updated=2026-10-16T10:00:00Z -->
### Fix the broken links
- [ ] Fix them
<!-- /auto session=b2c3d4e5 -->
`)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const play = keys => execFileSync(process.execPath, [script, '--keys', keys], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8' })
    // The question first, then the due-free task, then the stopped block.
    const ticked = play('down x')
    assert.ok(ticked.includes('Done: “Ask two referees”.'), ticked)
    assert.ok(readFileSync(path, 'utf8').includes('- [x] Ask two referees'))
    const journal = readdirSync(dir).find(name => name.includes('-journal-'))
    assert.ok(journal && readFileSync(join(dir, journal), 'utf8').includes('Job search · Fabrikam fellowship · Ask two referees'))
    const archived = play('down a')
    assert.ok(archived.includes('Archived “Fix the broken links”.'), archived)
    assert.ok(!readFileSync(path, 'utf8').includes('b2c3d4e5'))
    const archive = readdirSync(dir).find(name => name.includes('-archive-'))
    assert.ok(archive && readFileSync(join(dir, archive), 'utf8').includes('### Fix the broken links'))
    // The other agent's block and its question are untouched.
    assert.ok(readFileSync(path, 'utf8').includes('session=a1b2c3d4 agent=codex state=waiting'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('another session writing while the board ticks or archives loses neither the tick nor the archived block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    const file = `${FILE}
## Job search
### Fabrikam fellowship
- [x] Draft the statement
- [ ] Ask two referees

## docs-site
<!-- auto session=b2c3d4e5 agent=gemini state=ended updated=2026-10-16T10:00:00Z -->
### Fix the broken links
- [ ] Fix them
<!-- /auto session=b2c3d4e5 -->
`
    // Right after the board's first rename over progress.md, a Claude Code session writes its
    // own block, so the board's read-back differs and it tries again on the newer text.
    const preload = join(dir, 'other-session.cjs')
    writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const real = fs.renameSync
let done = false
fs.renameSync = (from, to) => {
  real(from, to)
  if (!done && String(to).endsWith('progress.md')) {
    done = true
    fs.writeFileSync(to, fs.readFileSync(to, 'utf8').replace('updated=2026-10-17T08:30:00Z', 'updated=2026-10-17T08:31:00Z'))
  }
}
syncBuiltinESMExports()
`)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const play = keys => execFileSync(process.execPath, ['-r', preload, script, '--keys', keys], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8' })
    writeFileSync(path, file)
    const ticked = play('down x')
    assert.ok(ticked.includes('Done: “Ask two referees”.'), ticked)
    assert.ok(readFileSync(path, 'utf8').includes('- [x] Ask two referees'))
    assert.ok(readFileSync(path, 'utf8').includes('updated=2026-10-17T08:31:00Z'))
    const journal = readdirSync(dir).find(name => name.includes('-journal-'))
    assert.ok(journal && readFileSync(join(dir, journal), 'utf8').includes('Ask two referees'))
    writeFileSync(path, file)
    const archived = play('down down a')
    assert.ok(archived.includes('Archived “Fix the broken links”.'), archived)
    assert.ok(!readFileSync(path, 'utf8').includes('b2c3d4e5'))
    const archive = readdirSync(dir).find(name => name.includes('-archive-'))
    const kept = archive ? readFileSync(join(dir, archive), 'utf8') : ''
    assert.equal(kept.split('### Fix the broken links').length - 1, 1, kept)
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The page's server, started the way `--serve` starts it in the background, on a synthetic
// progress.md: a closed Grok session with a question, a hand-kept task one step from done and
// a finished Gemini block. AGENT_BOARD_GROK stands in for Grok Build.
const GROK_ID = '01a14a94-0dee-7543-8208-991a4266a1da'

// Where the board script keeps a running page's address: in the folder for running programs
// (XDG_RUNTIME_DIR, here one of the test's own), named for the progress.md it serves.
const servedAt = (run, path) => join(run, `agent-board-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`)

const page = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const work = join(dir, 'api-gateway')
  mkdirSync(work)
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const path = join(dir, 'progress.md')
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(path, `# Progress

## api-gateway
<!-- auto session=b2c3d4e5 agent=grok state=ended updated=${recent} resume=${GROK_ID} dir=${encodeURIComponent(work)} -->
### Pick the cache
- [x] Measured both
- [?] Redis or Memcached?
<!-- /auto session=b2c3d4e5 -->

## Job search
### Fabrikam fellowship
- [x] Draft the statement
- [ ] Ask two referees

## docs-site
<!-- auto session=c3d4e5f6 agent=gemini state=done updated=${recent} -->
### Fix the broken links
- [x] Fix them
<!-- /auto session=c3d4e5f6 -->
`)
  const stand = join(dir, 'grok-stand-in.mjs')
  // Writes down how it was run, then answers after a second, so a second send meets the first.
  writeFileSync(stand, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dir, 'grok-ran.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
setTimeout(() => process.stdout.write('Redis it is; wiring it up now.\\n'), 1000)
`)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const child = spawn(process.execPath, [script, '--serve-child'], {
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_GROK: stand, XDG_RUNTIME_DIR: run },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise(done => child.once('exit', code => done(code)))
  const url = await new Promise((done, fail) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      out += chunk
      if (out.includes('\n')) done(new URL(out.split('\n')[0].trim()))
    })
    exited.then(code => fail(new Error(`the server exited with ${code}`)))
  })
  const port = Number(url.port)
  const token = url.searchParams.get('t')
  const call = (method, target, { body, headers = {} } = {}) =>
    new Promise((done, fail) => {
      const sent = { host: `127.0.0.1:${port}`, 'x-board-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
      const req = request({ host: '127.0.0.1', port, method, path: target, headers: sent }, res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (data += chunk))
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }))
      })
      req.on('error', fail)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const rows = async () => (await call('GET', '/api/board')).json().model.groups.flatMap(group => group.rows)
  const keyOf = async title => (await rows()).find(row => row.title === title)?.key
  const close = async () => {
    if (child.exitCode === null) await call('POST', '/api/close', { body: {} }).catch(() => undefined)
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))])
    if (code === 'still running') child.kill()
    rmSync(dir, { recursive: true, force: true })
    return code
  }
  return { dir, path, url, port, token, call, rows, keyOf, close, exited, served: servedAt(run, path) }
}

test('the page answers only with its token and its own host, and closing it stops the server', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { port, token, call } = board
    const home = await call('GET', `/?t=${token}`, { headers: { 'x-board-token': '' } })
    assert.equal(home.status, 200)
    assert.match(String(home.headers['content-security-policy']), /script-src 'nonce-[^']+'/)
    assert.equal(home.headers['referrer-policy'], 'no-referrer')
    // The chat prompt it offers to copy is the one docs/REMOTE_REPORTERS.md gives, word for word.
    const words = JSON.parse(home.body.match(/<script type="application\/json" id="words">([\s\S]*?)<\/script>/)[1])
    const doc = readFileSync(new URL('../docs/REMOTE_REPORTERS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(words.relayPrompt, doc.split('### Chat relay: a prompt to paste')[1].split('```text\n')[1].split('\n```')[0])
    assert.equal((await call('GET', '/?t=wrong', { headers: { 'x-board-token': '' } })).status, 403)
    assert.equal((await call('GET', '/api/board', { headers: { 'x-board-token': 'wrong' } })).status, 403)
    assert.equal((await call('GET', '/api/board', { headers: { host: `rebind.example:${port}` } })).status, 421)
    assert.equal((await call('POST', '/api/tidy', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await call('POST', '/api/tidy', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await call('GET', '/api/board')).status, 200)
    assert.ok(existsSync(board.served))
    assert.equal((await call('POST', '/api/close', { body: {} })).status, 200)
    assert.equal(await board.exited, 0)
    assert.ok(!existsSync(board.served))
  } finally {
    await board.close()
  }
})

test('ticking and tidying from the page write progress.md the way the pane does, and a pasted block is merged into it', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { path, call, keyOf } = board
    // The page sends the step it showed; once that step is done, the next one is not ticked in its place.
    const fabrikam = await keyOf('Fabrikam fellowship')
    assert.equal((await call('POST', '/api/act', { body: { key: fabrikam, type: 'tick', text: 'Draft the statement' } })).status, 409)
    const ticked = await call('POST', '/api/act', { body: { key: fabrikam, type: 'tick', text: 'Ask two referees' } })
    assert.equal(ticked.status, 200, ticked.body)
    assert.equal(ticked.json().note, 'Done: “Ask two referees”.')
    assert.ok(readFileSync(path, 'utf8').includes('- [x] Ask two referees'))
    const journal = readdirSync(board.dir).find(name => name.includes('-journal-'))
    assert.ok(journal && readFileSync(join(board.dir, journal), 'utf8').includes('Job search · Fabrikam fellowship · Ask two referees'))
    // A line that is gone since the page drew it is refused, not taken for another.
    assert.equal((await call('POST', '/api/act', { body: { key: 'row:gone', type: 'tick' } })).status, 409)
    const tidied = await call('POST', '/api/tidy', { body: {} })
    assert.equal(tidied.status, 200, tidied.body)
    const left = readFileSync(path, 'utf8')
    assert.ok(!left.includes('c3d4e5f6') && !left.includes('Fabrikam fellowship'), left)
    // The closed Grok session still has its three days.
    assert.ok(left.includes('session=b2c3d4e5'))
    const archive = readdirSync(board.dir).find(name => name.includes('-archive-'))
    const kept = archive ? readFileSync(join(board.dir, archive), 'utf8') : ''
    assert.ok(kept.includes('### Fix the broken links') && kept.includes('### Fabrikam fellowship'), kept)
    // Archived at the person's word, the task carries today's date, not the day before.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    assert.ok(kept.includes(`## Job search · ${today}\n### Fabrikam fellowship`), kept)
    // What a chat prints, fence and all, is merged under its project.
    const block = '## launch\n<!-- auto session=c0ffee12 agent=muse state=waiting updated=2020-01-01T00:00:00Z -->\n### Draft the launch post\n- [x] Outline\n- [?] Ship it Friday, OK?\n<!-- /auto session=c0ffee12 -->'
    const pasted = await call('POST', '/api/paste', { body: { text: `Here it is:\n\`\`\`\n${block}\n\`\`\`\n` } })
    assert.equal(pasted.status, 200, pasted.body)
    assert.ok(readFileSync(path, 'utf8').includes('## launch\n\n<!-- auto session=c0ffee12 agent=muse state=waiting updated='))
    assert.ok(!readFileSync(path, 'utf8').includes('updated=2020-01-01'))
    const refused = await call('POST', '/api/paste', { body: { text: block.replaceAll('c0ffee12', 'b2c3d4e5') } })
    assert.equal(refused.status, 409)
    assert.ok(readFileSync(path, 'utf8').includes(`resume=${GROK_ID}`))
  } finally {
    await board.close()
  }
})

test('a reply goes into a closed Grok session once, in its own folder, and the page waits for its answer before it closes', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { call, keyOf, rows } = board
    const key = await keyOf('Pick the cache')
    assert.equal((await rows()).find(row => row.key === key)?.send, 'send')
    // A page drawn when another session held that line does not send into this one.
    const stale = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'c0ffee12' } })
    assert.equal(stale.status, 409)
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    // The send is taken at once; the answer comes later, with the board.
    const first = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'b2c3d4e5' } })
    assert.equal(first.status, 202, first.body)
    assert.equal(first.json().note, 'Sent to grok · Pick the cache; its reply shows here when it comes (it can take a few minutes).')
    assert.equal((await rows()).find(row => row.key === key)?.isSending, true)
    const second = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Memcached', session: 'b2c3d4e5' } })
    assert.equal(second.status, 409)
    assert.equal(second.json().note, 'Another message is on its way to this grok session; send again once it replies.')
    // Closing now would cut the agent off halfway.
    const busy = await call('POST', '/api/close', { body: {} })
    assert.equal(busy.status, 409)
    assert.equal(busy.json().note, 'A message is still on its way to an agent; close the board once it replies.')
    let replies = []
    for (let tries = 0; replies.length === 0 && tries < 50; tries++) {
      await new Promise(done => setTimeout(done, 200))
      replies = (await call('GET', '/api/board')).json().replies
    }
    assert.equal(replies.length, 1, JSON.stringify(replies))
    assert.equal(replies[0].ok, true)
    assert.equal(replies[0].note, 'Sent to grok · Pick the cache. It replied: Redis it is; wiring it up now.')
    assert.equal((await rows()).find(row => row.key === key)?.isSending, false)
    const ran = JSON.parse(readFileSync(join(board.dir, 'grok-ran.json'), 'utf8'))
    assert.deepEqual(ran.args, ['-r', GROK_ID, '--single=About "Redis or Memcached?": Redis'])
    assert.equal(ran.cwd.toLowerCase(), join(board.dir, 'api-gateway').toLowerCase())
  } finally {
    await board.close()
  }
})

test('--serve starts the page in the background once, and the next --serve brings back the same page', { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const path = join(dir, 'progress.md')
  writeFileSync(path, FILE)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const serve = () => execFileSync(process.execPath, [script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: run }, encoding: 'utf8', timeout: 20_000 })
  const served = servedAt(run, path)
  let url = null
  try {
    const first = serve()
    assert.ok(first.startsWith('Progress  ● 1 waiting'), first)
    url = first.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1] ?? null
    assert.ok(url, first)
    assert.equal(JSON.parse(readFileSync(served, 'utf8')).url, url)
    const again = serve()
    assert.ok(again.includes(url), again)
  } finally {
    if (url !== null) {
      const { port, searchParams } = new URL(url)
      await new Promise(done => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/close', headers: { host: `127.0.0.1:${port}`, 'x-board-token': searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
        req.on('error', done)
        req.end('{}')
      })
      for (let tries = 0; existsSync(served) && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
      assert.ok(!existsSync(served))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// A synthetic board for --serve runs, with its own folder for running programs.
const serveIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const path = join(dir, 'progress.md')
  writeFileSync(path, FILE)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: run }
  const serve = () =>
    new Promise((done, fail) => execFile(process.execPath, [script, '--serve', '--no-open'], { env, encoding: 'utf8', timeout: 20_000 }, (error, out) => (error ? fail(error) : done(out))))
  const urlOf = out => out.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1] ?? null
  const served = servedAt(run, path)
  // Closes every page it was given and waits for each to take its address file away.
  const end = async urls => {
    for (const url of new Set(urls.filter(Boolean))) {
      const { port, searchParams } = new URL(url)
      await new Promise(done => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/close', headers: { host: `127.0.0.1:${port}`, 'x-board-token': searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
        req.on('error', done)
        req.end('{}')
      })
    }
    for (let tries = 0; existsSync(served) && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return { dir, path, script, env, serve, urlOf, served, end }
}

// A port nothing listens on.
const freePort = () =>
  new Promise(done => {
    const server = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

// The two runs may or may not meet halfway (one can find the other's page already written); the
// server started by hand always meets a page that is there.
test('two --serve run at the same moment open one page between them, and a server started while it runs stops at once', { timeout: 60_000 }, async () => {
  const board = serveIn()
  const urls = []
  try {
    const outs = await Promise.all([board.serve(), board.serve()])
    urls.push(...outs.map(board.urlOf))
    assert.ok(urls[0], outs[0])
    assert.equal(urls[1], urls[0], outs[1])
    // It finds the address file taken: it prints no address, leaves the file as it was and stops.
    const late = execFileSync(process.execPath, [board.script, '--serve-child'], { env: board.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(late, '')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, urls[0])
  } finally {
    await board.end(urls)
  }
})

test("the page's address stays out of progress.md's folder, and a file left by a page that is gone does not keep the next one from starting", { timeout: 60_000 }, async () => {
  const board = serveIn()
  const port = await freePort()
  const gone = { pid: 999999, port, url: `http://127.0.0.1:${port}/?t=gone`, path: board.path, built: '' }
  // Where 0.19.0 kept the address, token and all, and where this copy keeps it.
  const old = join(board.dir, 'progress-serve.json')
  writeFileSync(old, JSON.stringify(gone))
  writeFileSync(board.served, JSON.stringify(gone))
  const urls = []
  try {
    const first = board.urlOf(await board.serve())
    urls.push(first)
    assert.ok(first)
    assert.ok(!existsSync(old))
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, first)
    const token = new URL(first).searchParams.get('t')
    for (const entry of readdirSync(board.dir, { withFileTypes: true }).filter(one => one.isFile())) {
      assert.ok(!readFileSync(join(board.dir, entry.name), 'utf8').includes(token), entry.name)
    }
    await board.end([first])
  } catch (error) {
    await board.end(urls)
    throw error
  }
})

test('an address file cut short by a crash is cleared once it is old, and the next --serve starts a page', { timeout: 60_000 }, async () => {
  const board = serveIn()
  writeFileSync(board.served, '{"pid": 12')
  const past = new Date(Date.now() - 60_000)
  utimesSync(board.served, past, past)
  const urls = []
  try {
    urls.push(board.urlOf(await board.serve()))
    assert.ok(urls[0])
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, urls[0])
  } finally {
    await board.end(urls)
  }
})

// A request to the page at any of its addresses, the way a phone on the network sends one.
const fetchAt = (host, port, method, target, headers = {}, body) =>
  new Promise((done, fail) => {
    const sent = { host: `${host}:${port}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
    const req = request({ host, port, method, path: target, headers: sent }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (data += chunk))
      res.on('end', () => done({ status: res.statusCode, body: data, json: () => JSON.parse(data) }))
    })
    req.on('error', fail)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

test('with --lan the page also opens on the local network, with a token of its own, where a phone can tick but not send to an agent', { timeout: 30_000 }, async t => {
  const board = await page()
  try {
    const { call, port, token, keyOf } = board
    // Only the board script on the computer opens it: a script on a web page sends an Origin.
    assert.equal((await call('POST', '/api/lan', { body: {}, headers: { origin: `http://127.0.0.1:${port}` } })).status, 403)
    const opened = await call('POST', '/api/lan', { body: {} })
    if (opened.status === 409) {
      t.skip(`no local network address here: ${opened.json().note}`)
      return
    }
    assert.equal(opened.status, 200, opened.body)
    const lan = new URL(opened.json().url)
    const phone = lan.searchParams.get('t')
    const host = lan.hostname
    const lanPort = Number(lan.port)
    assert.notEqual(phone, token)
    // Asked again while it is open, it gives the same address.
    assert.equal((await call('POST', '/api/lan', { body: {} })).json().url, lan.href)
    assert.equal((await fetchAt(host, lanPort, 'GET', `/?t=${phone}`)).status, 200)
    // The computer's token and names are not taken there, nor the phone's token on the computer.
    assert.equal((await fetchAt(host, lanPort, 'GET', `/?t=${token}`)).status, 403)
    assert.equal((await fetchAt(host, lanPort, 'GET', '/api/board', { host: `127.0.0.1:${lanPort}`, 'x-board-token': phone })).status, 421)
    assert.equal((await call('GET', '/api/board', { headers: { 'x-board-token': phone } })).status, 403)
    // From the network it cannot be opened again, and a reply to an agent is refused.
    assert.equal((await fetchAt(host, lanPort, 'POST', '/api/lan', { 'x-board-token': phone }, {})).status, 403)
    // Nor does it say where progress.md is, which names the person's account.
    assert.equal((await fetchAt(host, lanPort, 'GET', '/api/ping', { 'x-board-token': phone })).status, 404)
    assert.equal((await call('GET', '/api/ping')).status, 200)
    const seen = (await fetchAt(host, lanPort, 'GET', '/api/board', { 'x-board-token': phone })).json()
    assert.equal(seen.model.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')?.send, 'open')
    const key = await keyOf('Pick the cache')
    const sent = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { key, type: 'send', text: 'Redis', session: 'b2c3d4e5' })
    assert.equal(sent.status, 409)
    assert.equal(sent.json().note, "A reply to grok runs a program on the computer, so it is sent from the computer's own page. You can copy the answer here.")
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    // A tick from the phone is written the way the computer's page writes one.
    const fabrikam = await keyOf('Fabrikam fellowship')
    const ticked = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { key: fabrikam, type: 'tick', text: 'Ask two referees' })
    assert.equal(ticked.status, 200, ticked.body)
    assert.ok(readFileSync(board.path, 'utf8').includes('- [x] Ask two referees'))
  } finally {
    await board.close()
  }
})

test("--serve --lan prints the page's network address and a QR code of it, and a second run gives the same address", { timeout: 60_000 }, async t => {
  const board = serveIn()
  const urls = []
  const serveLan = () =>
    new Promise((done, fail) => execFile(process.execPath, [board.script, '--serve', '--no-open', '--lan'], { env: board.env, encoding: 'utf8', timeout: 20_000 }, (error, out) => (error ? fail(error) : done(out))))
  try {
    const out = await serveLan()
    urls.push(board.urlOf(out))
    assert.ok(urls[0], out)
    const lan = out.match(/open (http:\/\/[\d.]+:\d+\/\?t=[\w-]+) or scan this code:/)?.[1]
    if (lan === undefined) {
      assert.ok(out.includes('This computer has no address on a local network'), out)
      t.skip('no local network address here')
      return
    }
    // NO_COLOR: the light modules are the ink, so the code's quiet zone prints as solid lines.
    assert.match(out, /scan this code:\n█{29,}\n█{29,}\n/)
    assert.ok(!out.includes('\u001b['))
    const again = await serveLan()
    assert.ok(again.includes(urls[0]), again)
    assert.ok(again.includes(lan), again)
  } finally {
    await board.end(urls)
  }
})

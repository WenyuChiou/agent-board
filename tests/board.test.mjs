// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

// The board script reads these times against the real clock: a waiting block shows as stopped
// after 12 hours, and an ended one is archived after three days. A fixed date would stop
// meaning the same thing the day after it was written, so each is an age from now.
const ago = ms => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const WAITING_AT = ago(45 * 60 * 1000)
const WRITTEN_AT = ago(44 * 60 * 1000)
const ENDED_AT = ago(23 * 60 * 60 * 1000)

const FILE = `# Progress

## api-gateway
<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=${WAITING_AT} -->
### Rate-limit the public endpoints
- [x] Added the token bucket middleware
- [?] Per-key limit — 100 or 300 a minute?
<!-- /auto session=a1b2c3d4 -->
`

const run = (lang, args = [], beside = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, FILE)
    for (const [name, text] of Object.entries(beside)) writeFileSync(join(dir, name), text)
    mkdirSync(join(dir, 'progress-inbox'))
    writeFileSync(join(dir, 'progress-inbox', 'gemini-turn-1-1.json'), JSON.stringify({ session_id: 'g1', cwd: join(dir, 'docs-site'), prompt_response: 'Fixed 12 broken links.' }))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    return execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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

test('the board script leaves out a question a pane on this machine marked answered', () => {
  const answered = JSON.stringify({ answered: ['a1b2c3d4 2 Per-key limit — 100 or 300 a minute?'] })
  const text = run('en', [], { 'progress-answered.json': answered })
  assert.ok(text.startsWith('Progress  ● 0 waiting'), text)
  assert.ok(text.includes('Nothing needs you right now\n1 answered, hidden'), text)
  // Its task stays with the work in progress, no longer saying it waits on you.
  assert.ok(text.includes('Rate-limit the public endpoints') && !text.includes('waiting on you'), text)
  // A broken file hides nothing.
  assert.ok(run('en', [], { 'progress-answered.json': '{' }).includes('Per-key limit'))
})

// Only the named filesystem calls fail, injected before the bundled script loads; not a real
// permission or disk failure.
test('a press on the board names an answered list it cannot read or replace, with its error, and never writes over it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    const list = join(dir, 'progress-answered.json')
    writeFileSync(path, FILE)
    mkdirSync(join(dir, 'progress-inbox'))
    const held = JSON.stringify({ answered: ['c0ffee12 1 Ship it, OK?'] })
    writeFileSync(list, held)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const preload = join(dir, 'fault.cjs')
    const play = fault => {
      writeFileSync(preload, `const fs = require('node:fs')\nconst { syncBuiltinESMExports } = require('node:module')\n${fault}\nsyncBuiltinESMExports()\n`)
      return spawnSync(process.execPath, ['-r', preload, script, '--keys', 'h'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
    }
    // `--keys h` reads the list twice to draw and choose the line, then once more to change it:
    // only that third read fails, so the press itself meets the error.
    const faults = [
      [`const original = fs.readFileSync\nlet reads = 0\nfs.readFileSync = (file, ...rest) => { if (String(file) === ${JSON.stringify(list)} && ++reads === 3) throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }); return original(file, ...rest) }`, 'EACCES'],
      [`const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(list)}) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }`, 'EIO'],
    ]
    for (const [fault, code] of faults) {
      const out = play(fault)
      const said = out.stdout + out.stderr
      assert.equal(out.status, 1, said)
      assert.ok(said.includes(list) && said.includes(code), said)
      assert.ok(!said.includes('Hidden:'), said)
      // The board is drawn after the press, with the question still on it.
      assert.ok(out.stdout.includes('Per-key limit'), said)
      assert.equal(readFileSync(list, 'utf8'), held)
      assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
    }
    // Once it can be read and replaced, the same press hides the question and keeps the old mark.
    const out = play('')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    const answered = JSON.parse(readFileSync(list, 'utf8')).answered
    assert.deepEqual([answered.length, answered[0], answered[1].startsWith('a1b2c3d4 2 ')], [2, 'c0ffee12 1 Ship it, OK?', true])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
<!-- auto session=b2c3d4e5 agent=gemini state=ended updated=${ENDED_AT} -->
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
<!-- auto session=b2c3d4e5 agent=gemini state=ended updated=${ENDED_AT} -->
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
    fs.writeFileSync(to, fs.readFileSync(to, 'utf8').replace(${JSON.stringify(`updated=${WAITING_AT}`)}, ${JSON.stringify(`updated=${WRITTEN_AT}`)}))
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
    assert.ok(readFileSync(path, 'utf8').includes(`updated=${WRITTEN_AT}`))
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

const page = async (more = '', env = {}) => {
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
${more.replaceAll('RECENT', recent)}`)
  const stand = join(dir, 'grok-stand-in.mjs')
  // Writes down how it was run, then answers after a second, so a second send meets the first.
  writeFileSync(stand, `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dir, 'grok-ran.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
setTimeout(() => process.stdout.write('Redis it is; wiring it up now.\\n'), 1000)
`)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const child = spawn(process.execPath, [script, '--serve-child'], {
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand, XDG_RUNTIME_DIR: run, ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, env.NODE_OPTIONS].filter(Boolean).join(' ') },
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
  const call = async (method, target, { body, headers = {} } = {}) => {
    if (target === '/api/act' && body?.asked === undefined && body?.question !== undefined) body = { asked: body.question, ...body }
    if ((target === '/api/tidy' || target === '/api/paste') && body !== undefined && body.revision === undefined) body = { ...body, revision: (await call('GET', '/api/board')).json().model.revision }
    if (target === '/api/act' && body !== undefined && body.identity === undefined) {
      const model = (await call('GET', '/api/board')).json().model
      const item = [...model.asks, ...model.groups.flatMap(group => group.rows)].find(one => one.key === body.key)
      body = { asked: item?.question ?? item?.text ?? '', ...body, identity: item?.identity ?? '', revision: item?.revision ?? '' }
    }
    return new Promise((done, fail) => {
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
  }
  const rows = async () => (await call('GET', '/api/board')).json().model.groups.flatMap(group => group.rows)
  const keyOf = async title => (await rows()).find(row => row.title === title)?.key
  const close = async () => {
    for (let i = 0; child.exitCode === null && i < 100; i++) {
      const result = await call('POST', '/api/close', { body: {} }).catch(() => null)
      if (result === null || result.status === 200) break
      await new Promise(done => setTimeout(done, 25))
    }
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))])
    if (code === 'still running') child.kill()
    rmSync(dir, { recursive: true, force: true })
    return code
  }
  return { dir, run, served: servedAt(run, path), path, script, child, stand, url, port, token, call, rows, keyOf, close, exited }
}

test('marking a question answered on the page or with h on the board writes only the hidden list, sends nothing, and shows it again', { timeout: 30_000 }, async () => {
  const board = await page(`
## billing
<!-- auto session=d4e5f6a7 agent=codex state=waiting updated=RECENT -->
### Pick the invoice format
- [?] PDF or HTML?
<!-- /auto session=d4e5f6a7 -->
`)
  try {
    const { call, dir, path } = board
    const before = readFileSync(path, 'utf8')
    const hidden = () => JSON.parse(readFileSync(join(dir, 'progress-answered.json'), 'utf8')).answered
    const model = async () => (await call('GET', '/api/board')).json().model
    const ask = (await model()).asks.find(one => one.agent === 'codex')
    assert.equal(ask.canHide, true)
    assert.deepEqual(ask.answers, ['PDF', 'HTML'])
    const hid = await call('POST', '/api/act', { body: { key: ask.key, type: 'hide' } })
    assert.equal(hid.status, 200, hid.body)
    assert.equal(hid.json().note, 'Hidden: “PDF or HTML?”; it comes back when the question changes.')
    assert.deepEqual(hidden(), ['d4e5f6a7 1 PDF or HTML?'])
    const after = await model()
    assert.equal(after.asks.some(one => one.agent === 'codex'), false)
    assert.deepEqual(after.hidden.map(one => one.text), ['PDF or HTML?'])
    // A quick answer pressed on the page drawn before the question was hidden is refused.
    const late = await call('POST', '/api/act', { body: { key: ask.key, type: 'send', text: 'PDF', session: 'd4e5f6a7' } })
    assert.equal(late.status, 409)
    assert.equal(late.json().note, 'That line just changed; check the one chosen now and press again.')
    const shown = await call('POST', '/api/act', { body: { key: after.hidden[0].key, type: 'unhide' } })
    assert.equal(shown.status, 200, shown.body)
    assert.deepEqual(hidden(), [])
    // The terminal board's h writes the same list, and u lists everything hidden again.
    const script = join(dir, 'agent-board.mjs')
    const play = keys => execFileSync(process.execPath, [script, '--keys', keys], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8' })
    const marked = play('h')
    assert.ok(marked.includes('Hidden: “PDF or HTML?”'), marked)
    assert.ok(marked.includes('1 answered, hidden · u show them again'), marked)
    assert.deepEqual(hidden(), ['d4e5f6a7 1 PDF or HTML?'])
    assert.equal((await model()).hidden.length, 1)
    const again = play('u')
    assert.ok(again.includes('The hidden questions are shown again.'), again)
    assert.deepEqual(hidden(), [])
    // A list written just now that is not JSON may be another write caught half-way: the press
    // leaves it and says so. Left broken for a while, it is written anew by the next press.
    const list = join(dir, 'progress-answered.json')
    writeFileSync(list, '{"answered": ["x"')
    const kept = play('h')
    assert.ok(kept.includes("Couldn't save that it was answered"), kept)
    const refused = await call('POST', '/api/act', { body: { key: ask.key, type: 'hide' } })
    assert.deepEqual([refused.status, refused.json().note], [409, "Couldn't save that it was answered; it stays on the list."])
    assert.equal(readFileSync(list, 'utf8'), '{"answered": ["x"')
    const old = new Date(Date.now() - 60_000)
    utimesSync(list, old, old)
    play('h')
    assert.deepEqual(hidden(), ['d4e5f6a7 1 PDF or HTML?'])
    // Nothing went to any agent, and every block is as its session wrote it.
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.ok(!existsSync(join(dir, 'grok-ran.json')))
  } finally {
    await board.close()
  }
})

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

test('stale archive, reply and manual question requests cannot act on same-title replacements', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const original = readFileSync(board.path, 'utf8')
    const row = (await board.rows()).find(row => row.title === 'Pick the cache')
    const replaced = original.replaceAll('b2c3d4e5', 'd4e5f6a7').replaceAll(GROK_ID, '22222222-2222-2222-2222-222222222222')
    writeFileSync(board.path, replaced)
    for (const type of ['archive', 'send']) {
      const response = await board.call('POST', '/api/act', { body: { ...row, type, text: 'Synthetic reply' } })
      assert.equal(response.status, 409, response.body)
      assert.equal(readFileSync(board.path, 'utf8'), replaced)
    }
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    writeFileSync(board.path, replaced.replace('- [ ] Ask two referees', '- [?] Ask two referees'))
    const ask = (await board.call('GET', '/api/board')).json().model.asks.find(ask => ask.project === 'Job search')
    const changed = readFileSync(board.path, 'utf8').replace('- [?] Ask two referees', '- [?] Submit the replacement application')
    writeFileSync(board.path, changed)
    assert.equal((await board.call('POST', '/api/act', { body: { ...ask, type: 'tick' } })).status, 409)
    assert.equal(readFileSync(board.path, 'utf8'), changed)
    const before = (await board.call('GET', '/api/board')).json().model.revision
    writeFileSync(board.path, changed + '\n## New work\n### Keep this\n- [ ] Still needed\n')
    assert.equal((await board.call('POST', '/api/tidy', { body: { revision: before } })).status, 409)
  } finally { await board.close() }
})

const delayedStand = (board, gate) => {
  writeFileSync(board.stand, `import { existsSync, appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(board.dir, 'calls.jsonl'))}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })+'\\n')
process.stdin.resume()
const end = Date.now()+8000
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})||Date.now()>end){clearInterval(timer);process.stdout.write('Synthetic answer\\n');process.exit(0)}},25)
`)
}

test('a busy older server refuses upgrade without publishing another sender', { timeout: 30_000 }, async () => {
  const board = await page()
  const gate = join(board.dir, 'release')
  try {
    delayedStand(board, gate)
    const row = (await board.rows()).find(row => row.title === 'Pick the cache')
    assert.equal((await board.call('POST', '/api/act', { body: { ...row, type: 'send', text: 'Synthetic delayed reply' } })).status, 202)
    const previous = readFileSync(board.served, 'utf8')
    const stamp = statSync(board.script)
    utimesSync(board.script, stamp.atime, new Date(stamp.mtimeMs + 5000))
    assert.throws(() => execFileSync(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: board.run }, encoding: 'utf8', timeout: 10_000, windowsHide: true }), error => error.status === 1 && error.stdout.includes('A message is still on its way'))
    assert.equal(readFileSync(board.served, 'utf8'), previous)
    assert.equal((await board.call('GET', '/api/ping')).json().sending, 1)
  } finally { writeFileSync(gate, 'release'); await board.close() }
})

test('a busy legacy page keeps its address and blocks migration until the send finishes', { timeout: 30_000 }, async () => {
  const board = await page()
  const gate = join(board.dir, 'release')
  const legacy = join(board.dir, 'progress-serve.json')
  const previous = readFileSync(board.served, 'utf8')
  try {
    delayedStand(board, gate)
    const row = (await board.rows()).find(row => row.title === 'Pick the cache')
    assert.equal((await board.call('POST', '/api/act', { body: { ...row, type: 'send', text: 'Synthetic migration reply' } })).status, 202)
    writeFileSync(legacy, previous)
    rmSync(board.served)
    assert.throws(() => execFileSync(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: board.run }, encoding: 'utf8', timeout: 10_000, windowsHide: true }), error => error.status === 1 && error.stdout.includes('A message is still on its way'))
    assert.equal(readFileSync(legacy, 'utf8'), previous)
    assert.ok(!existsSync(board.served))
    assert.equal((await board.call('GET', '/api/ping')).json().sending, 1)
  } finally {
    writeFileSync(board.served, previous)
    rmSync(legacy, { force: true })
    writeFileSync(gate, 'release')
    await board.close()
  }
})

test('malformed legacy metadata blocks migration without changing either address', { timeout: 30_000 }, async () => {
  const board = await page()
  const legacy = join(board.dir, 'progress-serve.json')
  const previous = readFileSync(board.served, 'utf8')
  try {
    writeFileSync(legacy, '{not valid metadata')
    rmSync(board.served)
    assert.throws(() => execFileSync(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: board.run }, encoding: 'utf8', timeout: 10_000, windowsHide: true }), error => error.status === 1 && error.stdout.includes("Couldn't open the board page"))
    assert.equal(readFileSync(legacy, 'utf8'), '{not valid metadata')
    assert.ok(!existsSync(board.served))
    assert.equal((await board.call('GET', '/api/ping')).status, 200)
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
  } finally {
    writeFileSync(board.served, previous)
    await board.close()
  }
})

test('legacy uncertain claims block public startup after a crash and cannot be replayed', { timeout: 30_000 }, async () => {
  const board = await page()
  const gate = join(board.dir, 'release')
  const legacy = join(board.dir, 'progress-serve.json')
  try {
    delayedStand(board, gate)
    const row = (await board.rows()).find(row => row.title === 'Pick the cache')
    assert.equal((await board.call('POST', '/api/act', { body: { ...row, type: 'send', text: 'Synthetic legacy reply' } })).status, 202)
    for (let i = 0; !existsSync(join(board.dir, 'calls.jsonl')) && i < 100; i++) await new Promise(done => setTimeout(done, 25))
    assert.ok(existsSync(join(board.dir, 'calls.jsonl')))
    const address = readFileSync(board.served, 'utf8')
    const claims = readdirSync(board.served + '.sends')
    assert.equal(claims.length, 1)
    const claim = readFileSync(join(board.served + '.sends', claims[0]), 'utf8')
    board.child.kill()
    await board.exited
    mkdirSync(legacy + '.sends')
    writeFileSync(join(legacy + '.sends', claims[0]), claim)
    rmSync(board.served + '.sends', { recursive: true })
    writeFileSync(legacy, address)
    rmSync(board.served)
    const serve = () => execFileSync(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_CODEX: board.stand, AGENT_BOARD_GROK: board.stand, XDG_RUNTIME_DIR: board.run }, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    assert.throws(serve, error => error.status === 1 && error.stdout.includes('Previous send records remain in'))
    assert.equal(readFileSync(legacy, 'utf8'), address)
    // The claim still blocks startup even if the old address is absent.
    rmSync(legacy)
    assert.throws(serve, error => error.status === 1 && error.stdout.includes('Previous send records remain in'))
    assert.equal(readFileSync(join(legacy + '.sends', claims[0]), 'utf8'), claim)
    assert.ok(!existsSync(board.served))
    assert.ok(!existsSync(board.served + '.sends'))
    assert.equal(readFileSync(join(board.dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1)
  } finally {
    writeFileSync(gate, 'release')
    await new Promise(done => setTimeout(done, 100))
    await board.close()
  }
})

test('an uncertain claim created while a legacy page closes still blocks private startup', { timeout: 30_000 }, async () => {
  const board = await page()
  const legacy = join(board.dir, 'progress-serve.json')
  const claim = join(legacy + '.sends', 'closing-send.json')
  const old = createServer((req, res) => {
    if (req.url === '/api/close') {
      mkdirSync(legacy + '.sends')
      writeFileSync(claim, '{"status":"uncertain"}')
      res.end('{}')
      old.close()
    } else { res.writeHead(404); res.end('{}') }
  })
  try {
    await board.call('POST', '/api/close', { body: {} })
    await board.exited
    await new Promise(done => old.listen(0, '127.0.0.1', done))
    const port = old.address().port
    writeFileSync(legacy, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/?t=synthetic`, path: board.path, built: 'legacy' }))
    await assert.rejects(new Promise((done, fail) => execFile(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: board.run }, encoding: 'utf8', timeout: 10_000, windowsHide: true }, (error, out) => error ? fail(Object.assign(error, { out })) : done(out))), error => error.code === 1 && error.out.includes('Previous send records remain in'))
    assert.equal(readFileSync(claim, 'utf8'), '{"status":"uncertain"}')
    assert.ok(!existsSync(board.served))
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
  } finally {
    old.closeAllConnections()
    if (old.listening) await new Promise(done => old.close(done))
    await board.close()
  }
})

test('an interrupted send remains uncertain after its server is restarted and cannot be replayed', { timeout: 30_000 }, async () => {
  const board = await page()
  const gate = join(board.dir, 'release')
  let replacement
  let replacementUrl
  try {
    delayedStand(board, gate)
    writeFileSync(board.path, readFileSync(board.path, 'utf8').replace('agent=grok', 'agent=codex'))
    const row = (await board.rows()).find(row => row.title === 'Pick the cache')
    assert.equal((await board.call('POST', '/api/act', { body: { ...row, type: 'send', text: 'Synthetic interrupted reply' } })).status, 202)
    for (let i = 0; !existsSync(join(board.dir, 'calls.jsonl')) && i < 100; i++) await new Promise(done => setTimeout(done, 25))
    assert.ok(existsSync(join(board.dir, 'calls.jsonl')))
    board.child.kill()
    await board.exited
    // Public startup recovers the crashed address before exclusive publication.
    replacement = spawn(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_CODEX: board.stand, AGENT_BOARD_GROK: board.stand, XDG_RUNTIME_DIR: board.run }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    replacementUrl = await new Promise((done, fail) => {
      let out = ''
      const timer = setTimeout(() => fail(new Error('replacement startup timed out')), 5000)
      replacement.stdout.on('data', chunk => { out += chunk; const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]; if (url) { clearTimeout(timer); done(new URL(url)) } })
      replacement.once('exit', code => { clearTimeout(timer); fail(new Error(`replacement exited: ${code}`)) })
    })
    const headers = { 'x-board-token': replacementUrl.searchParams.get('t'), 'content-type': 'application/json' }
    const model = await (await fetch(new URL('/api/board', replacementUrl), { headers })).json()
    const current = model.model.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')
    assert.equal(current.isSending, true)
    assert.ok(current.info.includes('uncertain outcome'))
    const response = await fetch(new URL('/api/act', replacementUrl), { method: 'POST', headers, body: JSON.stringify({ ...current, type: 'send', text: 'Never replay' }) })
    assert.equal(response.status, 409)
    assert.equal(readFileSync(join(board.dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1)
    assert.equal(readdirSync(board.served + '.sends').length, 1)
  } finally {
    writeFileSync(gate, 'release')
    if (replacementUrl) await fetch(new URL('/api/close', replacementUrl), { method: 'POST', headers: { 'x-board-token': replacementUrl.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    if (replacement && replacement.exitCode === null) await Promise.race([new Promise(done => replacement.once('exit', done)), new Promise(done => setTimeout(done, 3000))])
    if (replacement && replacement.exitCode === null) replacement.kill()
    for (let i = 0; existsSync(board.served + '.owner') && i < 100; i++) await new Promise(done => setTimeout(done, 25))
    await new Promise(done => setTimeout(done, 100))
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

test('a board the page cannot read is named there with that file and its error, rather than shown as offline, and a phone is told the file name only', { timeout: 30_000 }, async () => {
  // Every read of the journal fails, the way a file without read access would.
  const faults = mkdtempSync(join(tmpdir(), 'board-fault-'))
  const preload = join(faults, 'fault.cjs')
  writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const original = fs.readFileSync
fs.readFileSync = (path, ...args) => { if (String(path).includes('-journal-')) throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }); return original(path, ...args) }
syncBuiltinESMExports()
`)
  const board = await page('', { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  try {
    const seen = await board.call('GET', '/api/board')
    assert.equal(seen.status, 409, seen.body)
    assert.match(seen.json().note, /^Could not safely read or update .*-journal-.*\(EACCES\)/)
    // The page says that note, and "offline" only when the board sent none.
    const home = await board.call('GET', `/?t=${board.token}`, { headers: { 'x-board-token': '' } })
    assert.ok(home.body.includes("say(data.note || w('serveOffline'), 'alert')"))
    // A phone on the network is told the file's name, not the folder it is in, which names the
    // person's account.
    const opened = await board.call('POST', '/api/lan', { body: {} })
    if (opened.status === 200) {
      const lan = new URL(opened.json().url)
      const far = await fetchAt(lan.hostname, Number(lan.port), 'GET', '/api/board', { 'x-board-token': lan.searchParams.get('t') })
      assert.equal(far.status, 409, far.body)
      assert.match(far.json().note, /^Could not safely read or update progress-journal-\d{4}-\d{2}\.md \(EACCES\)/)
      assert.ok(!far.json().note.includes(board.dir), far.json().note)
    }
  } finally {
    await board.close()
    rmSync(faults, { recursive: true, force: true })
  }
})

test('a press on the page that cannot write its history is answered with that file and its error, and progress.md is left as it was', { timeout: 30_000 }, async () => {
  // Every write that would land on the journal fails, the way a failing disk would.
  const faults = mkdtempSync(join(tmpdir(), 'board-fault-'))
  const preload = join(faults, 'fault.cjs')
  writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const original = fs.renameSync
fs.renameSync = (from, to) => { if (String(to).includes('-journal-')) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }
syncBuiltinESMExports()
`)
  const board = await page('', { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  try {
    const { path, call, keyOf } = board
    const before = readFileSync(path, 'utf8')
    const ticked = await call('POST', '/api/act', { body: { key: await keyOf('Fabrikam fellowship'), type: 'tick', text: 'Ask two referees' } })
    assert.equal(ticked.status, 409, ticked.body)
    assert.match(ticked.json().note, /^Could not safely read or update .*-journal-.*\(EIO\)/)
    assert.equal(readFileSync(path, 'utf8'), before)
    // The page runs on, with the step still there to tick again.
    assert.equal((await call('GET', '/api/board')).status, 200)
    assert.ok(await keyOf('Fabrikam fellowship'))
  } finally {
    await board.close()
    rmSync(faults, { recursive: true, force: true })
  }
})

test('a hide on the page that cannot replace the answered list is answered with that file and its error', { timeout: 30_000 }, async () => {
  const faults = mkdtempSync(join(tmpdir(), 'board-fault-'))
  const preload = join(faults, 'fault.cjs')
  writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const original = fs.renameSync
fs.renameSync = (from, to) => { if (String(to).endsWith('progress-answered.json')) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); return original(from, to) }
syncBuiltinESMExports()
`)
  const board = await page(`
## billing
<!-- auto session=d4e5f6a7 agent=codex state=waiting updated=RECENT -->
### Pick the invoice format
- [?] PDF or HTML?
<!-- /auto session=d4e5f6a7 -->
`, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  try {
    const { call, dir } = board
    const ask = (await call('GET', '/api/board')).json().model.asks.find(one => one.agent === 'codex')
    const hid = await call('POST', '/api/act', { body: { key: ask.key, type: 'hide' } })
    assert.equal(hid.status, 409, hid.body)
    assert.match(hid.json().note, /^Could not safely read or update .*progress-answered\.json \(EIO\)/)
    assert.ok(!existsSync(join(dir, 'progress-answered.json')))
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
    // The question is still asked on the page.
    assert.ok((await call('GET', '/api/board')).json().model.asks.some(one => one.key === ask.key))
  } finally {
    await board.close()
    rmSync(faults, { recursive: true, force: true })
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
    // A reply written under a question the task no longer asks does not go either.
    const reworded = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Which port?' } })
    assert.equal(reworded.status, 409)
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    const first = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Redis or Memcached?' } })
    assert.equal(first.status, 202, first.body)
    assert.equal(first.json().note, 'Sent to grok · Pick the cache; its reply shows here when it comes (it can take a few minutes).')
    assert.equal((await rows()).find(row => row.key === key)?.isSending, true)
    const second = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Memcached', session: 'b2c3d4e5', asked: 'Redis or Memcached?' } })
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
  // A successful old send leaves an empty directory; it must not block upgrade.
  mkdirSync(join(dir, 'progress-serve.json.sends'))
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

test('simultaneous cold starters publish one server and reuse the winning page', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-start-race-'))
  const path = join(dir, 'progress.md')
  const script = join(dir, 'agent-board.mjs')
  const preload = join(dir, 'barrier.mjs')
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const served = servedAt(run, path)
  writeFileSync(path, FILE)
  writeFileSync(script, `globalThis.AGENT_BOARD=${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  // Both parent commands observe an absent address before either may spawn.
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const stat=fs.lstatSync;let held=false;
fs.lstatSync=function(file,...args){if(!held&&process.argv.includes('--serve')&&String(file)===${JSON.stringify(served)}&&!fs.existsSync(file)){held=true;fs.writeFileSync(${JSON.stringify(join(dir, 'ready-'))}+process.pid,'ready');const end=Date.now()+5000;while(fs.readdirSync(${JSON.stringify(dir)}).filter(x=>x.startsWith('ready-')).length<2&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return stat.call(this,file,...args)};syncBuiltinESMExports();`)
  const urls = new Set()
  try {
    const start = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, [script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: run, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', fail)
      child.on('close', code => {
        const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]
        if (url) urls.add(url)
        done({ code, out, url })
      })
    })
    const result = await Promise.all([start(), start()])
    assert.ok(result.every(one => one.code === 0 && one.url), JSON.stringify(result))
    assert.equal(urls.size, 1)
    assert.equal(JSON.parse(readFileSync(served, 'utf8')).url, [...urls][0])
  } finally {
    for (const value of urls) {
      const url = new URL(value)
      await fetch(new URL('/api/close', url), { method: 'POST', headers: { 'x-board-token': url.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    }
    for (let i = 0; existsSync(served + '.owner') && i < 100; i++) await new Promise(done => setTimeout(done, 25))
    assert.ok(!existsSync(served + '.owner'))
    // Windows may retain the server's cwd briefly after its exit callback released the lease.
    await new Promise(done => setTimeout(done, 100))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// The actual page script runs against a minimal DOM and a deterministic transport.
// No browser, real board, agent command or network is involved in its redraw tests.
const pageDom = async (html, first, action = async () => ({ ok: false, json: async () => ({ note: 'Synthetic conflict' }) })) => {
  const nodes = new Map()
  let active = null
  class Element {
    constructor(tag) { this.tag = tag; this.childNodes = []; this.attributes = {}; this.events = {}; this.value = ''; this.text = '' }
    set textContent(value) { this.text = value; this.childNodes = [] }
    get textContent() { return this.text + this.childNodes.map(child => child.textContent).join('') }
    appendChild(child) { this.childNodes.push(child); return child }
    removeChild(child) { this.childNodes = this.childNodes.filter(one => one !== child) }
    setAttribute(key, value) { this.attributes[key] = value }
    getAttribute(key) { return this.attributes[key] ?? null }
    addEventListener(key, callback) { this.events[key] = callback }
    querySelectorAll(selector) { return this.childNodes.flatMap(child => [...(child.tag === 'textarea' && (selector === 'textarea' || selector === 'textarea[data-key]' && child.getAttribute('data-key') !== null) ? [child] : []), ...child.querySelectorAll(selector)]) }
    click() { if (!this.disabled) this.events.click?.() }
    focus() { active = this }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  }
  for (const id of ['words', 'board', 'counts', 'note', 'close', 'paste-go', 'paste', 'relay', 'main']) nodes.set(id, new Element(id))
  nodes.get('words').textContent = html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1]
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node }, querySelector: name => nodes.get(name), get activeElement() { return active } }
  let model = first
  let scheduled
  const requests = []
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('(function ()'))
  runInNewContext(script, { document, location: { search: '?t=synthetic-token' }, URLSearchParams, navigator: {}, window: {}, setTimeout: callback => { scheduled = callback; return 1 }, clearTimeout: () => {}, fetch: async (path, options) => {
    if (path === '/api/board') return { ok: true, json: async () => ({ model, now: 1 }) }
    requests.push(JSON.parse(options.body))
    return action()
  } })
  const flush = () => new Promise(done => setImmediate(done))
  await flush()
  return { board: nodes.get('board'), requests, flush, redraw: async next => { model = next; scheduled(); await flush() } }
}

test('hiding a question retains its old draft instead of converting it into a general message', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const first = (await board.call('GET', '/api/board')).json().model
    const grok = first.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')
    const dom = await pageDom(html, first)
    const key = JSON.stringify([grok.identity, grok.revision])
    const box = dom.board.querySelectorAll('textarea[data-key]').find(one => one.getAttribute('data-key') === key)
    box.value = 'Synthetic answer to the previous question'
    box.events.input()
    writeFileSync(join(board.dir, 'progress-answered.json'), JSON.stringify({ answered: ['b2c3d4e5 2 Redis or Memcached?'] }))
    const after = (await board.call('GET', '/api/board')).json().model
    const changed = after.groups.flatMap(group => group.rows).find(row => row.title === grok.title)
    assert.equal(changed.question, '')
    assert.equal(changed.identity, grok.identity)
    assert.notEqual(changed.revision, grok.revision)
    await dom.redraw(after)
    const current = dom.board.querySelectorAll('textarea[data-key]').find(one => one.getAttribute('data-key') === JSON.stringify([changed.identity, changed.revision]))
    assert.equal(current.value, '')
    assert.ok(dom.board.textContent.includes('Target changed; unsent draft retained:'))
    assert.ok(dom.board.querySelectorAll('textarea').some(one => one.value === 'Synthetic answer to the previous question'))
    assert.equal(dom.requests.length, 0)
  } finally { await board.close() }
})

test('page drafts stay with the same source revision and survive a rejected send', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const first = (await board.call('GET', '/api/board')).json().model
    const dom = await pageDom(html, first)
    const box = dom.board.querySelectorAll('textarea[data-key]')[0]
    box.value = 'Synthetic draft for A'
    box.events.input?.()
    const original = readFileSync(board.path, 'utf8')
    writeFileSync(board.path, original.replaceAll('b2c3d4e5', 'd4e5f6a7').replaceAll(GROK_ID, '22222222-2222-2222-2222-222222222222'))
    const replacement = (await board.call('GET', '/api/board')).json().model
    await dom.redraw(replacement)
    assert.equal(dom.board.querySelectorAll('textarea[data-key]')[0].value, '')
    assert.ok(dom.board.textContent.includes('Target changed; unsent draft retained:'))
    await dom.redraw(first)
    const restored = dom.board.querySelectorAll('textarea[data-key]')[0]
    assert.equal(restored.value, 'Synthetic draft for A')
    const findButton = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...findButton(child)])
    findButton(dom.board).find(button => button.textContent === 'Send to grok').click()
    await dom.flush()
    assert.equal(dom.requests.length, 1)
    assert.equal(dom.requests[0].identity, first.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache').identity)
    assert.equal(dom.board.querySelectorAll('textarea[data-key]')[0].value, 'Synthetic draft for A')
  } finally { await board.close() }
})

test('a delayed send acknowledgement clears accepted text after redraw and preserves later edits', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const first = (await board.call('GET', '/api/board')).json().model
    for (const later of ['', 'New text typed after submission']) {
      let acknowledge
      const dom = await pageDom(html, first, () => new Promise(done => { acknowledge = done }))
      const input = () => dom.board.querySelectorAll('textarea[data-key]')[0]
      input().value = 'Accepted synthetic reply'
      input().events.input()
      const buttons = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...buttons(child)])
      buttons(dom.board).find(button => button.textContent === 'Send to grok').click()
      await dom.flush()
      const sending = structuredClone(first)
      for (const row of sending.groups.flatMap(group => group.rows)) row.isSending = true
      await dom.redraw(sending)
      if (later) { input().value = later; input().events.input() }
      acknowledge({ ok: true, json: async () => ({ note: 'Synthetic accepted' }) })
      await dom.flush()
      assert.equal(input().value, later)
      await dom.redraw(first)
      assert.equal(input().value, later)
      assert.equal(dom.requests.length, 1)
    }
  } finally { await board.close() }
})

test('terminal watch validates the last drawn task before acting on a same-key replacement', { timeout: 15_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-watch-stale-'))
  const path = join(dir, 'progress.md')
  const script = join(dir, 'agent-board.mjs')
  const preload = join(dir, 'replace-after-draw.mjs')
  const initial = `# Progress\n\n## synthetic\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-17T08:30:00Z -->\n### Synthetic same-title task\n- [ ] Keep this task\n<!-- /auto session=a1b2c3d4 -->\n`
  const replacement = initial.replaceAll('a1b2c3d4', 'd4e5f6a7')
  writeFileSync(path, initial)
  writeFileSync(script, `globalThis.AGENT_BOARD=${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  // Run the real --watch input handler. Replace A only after its first screen is
  // written, then press archive before the next timed redraw can show B.
  writeFileSync(preload, `import fs from 'node:fs';
Object.defineProperty(process.stdin,'isTTY',{value:true});process.stdin.setRawMode=()=>{};
const write=process.stdout.write.bind(process.stdout);let drawn=false;
process.stdout.write=function(text,...args){const result=write(text,...args);if(!drawn&&String(text).startsWith('\\x1b[2J\\x1b[H')){drawn=true;fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(replacement)});queueMicrotask(()=>{process.stdin.emit('data','a');process.stdin.emit('data','q')})}return result};`)
  try {
    const out = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--watch'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(readFileSync(path, 'utf8'), replacement, out)
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('a send acknowledged after its recipient changes removes only the accepted retained draft', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const first = (await board.call('GET', '/api/board')).json().model
    for (const later of ['', 'A newer retained draft']) {
      let acknowledge
      const dom = await pageDom(html, first, () => new Promise(done => { acknowledge = done }))
      const input = () => dom.board.querySelectorAll('textarea[data-key]')[0]
      input().value = 'Accepted synthetic reply'
      input().events.input()
      const buttons = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...buttons(child)])
      buttons(dom.board).find(button => button.textContent === 'Send to grok').click()
      await dom.flush()
      if (later) { input().value = later; input().events.input() }
      const replacement = structuredClone(first)
      for (const row of replacement.groups.flatMap(group => group.rows)) {
        row.identity += ':replacement'
        row.revision += ':replacement'
      }
      await dom.redraw(replacement)
      assert.ok(dom.board.textContent.includes('Target changed; unsent draft retained:'))
      acknowledge({ ok: true, json: async () => ({ note: 'Synthetic accepted' }) })
      await dom.flush()
      assert.equal(dom.board.textContent.includes('Target changed; unsent draft retained:'), Boolean(later))
      assert.equal(input().value, '')
      await dom.redraw(replacement)
      assert.equal(dom.board.textContent.includes('Target changed; unsent draft retained:'), Boolean(later))
      await dom.redraw(first)
      assert.equal(input().value, later)
    }
  } finally { await board.close() }
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
    assert.throws(() => execFileSync(process.execPath, [board.script, '--serve-child'], { env: board.env, encoding: 'utf8', timeout: 10_000 }), error => error.status === 1 && error.stdout === '')
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
  // So is one whose address is not an address.
  const second = serveIn()
  writeFileSync(second.served, JSON.stringify({ pid: 1, port: 1, url: 'x' }))
  utimesSync(second.served, past, past)
  const more = []
  try {
    more.push(second.urlOf(await second.serve()))
    assert.ok(more[0])
  } finally {
    await second.end(more)
  }
})

test('the same progress.md named two ways brings back the same page', { timeout: 60_000 }, async () => {
  const board = serveIn()
  const urls = []
  try {
    urls.push(board.urlOf(await board.serve()))
    assert.ok(urls[0])
    // The board script was written for this file; the person names it again with / for \ and a detour.
    const other = `${board.dir}/run/../progress.md`.replace(/\\/g, '/')
    const again = await new Promise((done, fail) =>
      execFile(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...board.env, CLAUDE_PROGRESS_FILE: other }, encoding: 'utf8', timeout: 20_000 }, (error, out) => (error ? fail(error) : done(out))),
    )
    urls.push(board.urlOf(again))
    assert.equal(urls[1], urls[0], again)
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
    // An address that is not one of the computer's own is named as such.
    const wrong = await call('POST', '/api/lan', { body: { address: '8.8.8.8' } })
    assert.equal(wrong.status, 409)
    assert.equal(wrong.json().note, "8.8.8.8 is not a private network address of this computer, so the board can't open there.")
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
    const agents = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'hermes', 'openclaw', 'opencode']
    const hiddenPath = join(board.dir, 'synthetic-private-account')
    const hiddenResume = '11111111-2222-3333-4444-555555555555'
    writeFileSync(board.path, readFileSync(board.path, 'utf8') + agents.map((agent, index) => `\n## privacy-${agent}\n<!-- auto session=${String(index + 1).repeat(8)} agent=${agent} state=ended updated=2026-10-17T08:30:00Z resume=${hiddenResume} dir=${encodeURIComponent(hiddenPath)} -->\n### Private metadata for ${agent}\n- [ ] Keep working\n<!-- /auto session=${String(index + 1).repeat(8)} -->\n`).join(''))
    const seen = (await fetchAt(host, lanPort, 'GET', '/api/board', { 'x-board-token': phone })).json()
    const payload = JSON.stringify(seen)
    const privatePath = join(board.dir, 'api-gateway')
    assert.ok(!payload.includes(JSON.stringify(privatePath).slice(1, -1)))
    assert.ok(!payload.includes(encodeURIComponent(privatePath)))
    assert.ok(!payload.includes(GROK_ID))
    assert.ok(!payload.includes(JSON.stringify(hiddenPath).slice(1, -1)))
    assert.ok(!payload.includes(encodeURIComponent(hiddenPath)))
    assert.ok(!payload.includes(hiddenResume))
    for (const agent of agents) {
      const row = seen.model.groups.flatMap(group => group.rows).find(row => row.title === `Private metadata for ${agent}`)
      assert.ok(row, `missing ${agent}`)
      assert.match(row.identity, /^[a-f0-9]{64}$/)
      assert.match(row.revision, /^[a-f0-9]{64}$/)
    }
    assert.equal(seen.model.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')?.send, 'open')
    const row = seen.model.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')
    assert.match(row.identity, /^[a-f0-9]{64}$/)
    assert.match(row.revision, /^[a-f0-9]{64}$/)
    const sent = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { ...row, type: 'send', text: 'Redis' })
    assert.equal(sent.status, 409)
    assert.equal(sent.json().note, "A reply to grok runs a program on the computer, so it is sent from the computer's own page. You can copy the answer here.")
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    // A tick from the phone is written the way the computer's page writes one.
    const fabrikam = seen.model.groups.flatMap(group => group.rows).find(row => row.title === 'Fabrikam fellowship')
    const ticked = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { ...fabrikam, type: 'tick', text: 'Ask two referees' })
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

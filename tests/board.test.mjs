// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
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

const page = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const work = join(dir, 'api-gateway')
  mkdirSync(work)
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
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand },
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
    if ((target === '/api/tidy' || target === '/api/paste') && body !== undefined && body.revision === undefined) body = { ...body, revision: (await call('GET', '/api/board')).json().model.revision }
    if (target === '/api/act' && body !== undefined && body.identity === undefined) {
      const model = (await call('GET', '/api/board')).json().model
      const item = [...model.asks, ...model.groups.flatMap(group => group.rows)].find(one => one.key === body.key)
      body = { ...body, identity: item?.identity ?? '', revision: item?.revision ?? '' }
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
  return { dir, path, script, child, stand, url, port, token, call, rows, keyOf, close, exited }
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
    assert.ok(existsSync(join(board.dir, 'progress-serve.json')))
    assert.equal((await call('POST', '/api/close', { body: {} })).status, 200)
    assert.equal(await board.exited, 0)
    assert.ok(!existsSync(join(board.dir, 'progress-serve.json')))
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
    const previous = readFileSync(join(board.dir, 'progress-serve.json'), 'utf8')
    const stamp = statSync(board.script)
    utimesSync(board.script, stamp.atime, new Date(stamp.mtimeMs + 5000))
    assert.throws(() => execFileSync(process.execPath, [board.script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000, windowsHide: true }), error => error.status === 1 && error.stdout.includes('A message is still on its way'))
    assert.equal(readFileSync(join(board.dir, 'progress-serve.json'), 'utf8'), previous)
    assert.equal((await board.call('GET', '/api/ping')).json().sending, 1)
  } finally { writeFileSync(gate, 'release'); await board.close() }
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
    replacement = spawn(process.execPath, [board.script, '--serve-child'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_CODEX: board.stand }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    replacementUrl = await new Promise((done, fail) => {
      let out = ''
      const timer = setTimeout(() => fail(new Error('replacement startup timed out')), 5000)
      replacement.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) { clearTimeout(timer); done(new URL(out.split('\n')[0].trim())) } })
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
    assert.equal(readdirSync(join(board.dir, 'progress-serve.json.sends')).length, 1)
  } finally {
    writeFileSync(gate, 'release')
    if (replacementUrl) await fetch(new URL('/api/close', replacementUrl), { method: 'POST', headers: { 'x-board-token': replacementUrl.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    if (replacement && replacement.exitCode === null) await Promise.race([new Promise(done => replacement.once('exit', done)), new Promise(done => setTimeout(done, 3000))])
    if (replacement && replacement.exitCode === null) replacement.kill()
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
  const serve = () => execFileSync(process.execPath, [script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 20_000 })
  const served = join(dir, 'progress-serve.json')
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
  const served = join(dir, 'progress-serve.json')
  writeFileSync(path, FILE)
  writeFileSync(script, `globalThis.AGENT_BOARD=${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  // Both parent commands observe an absent address before either may spawn.
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const read=fs.readFileSync;let held=false;
fs.readFileSync=function(file,...args){if(!held&&process.argv.includes('--serve')&&String(file)===${JSON.stringify(served)}&&!fs.existsSync(file)){held=true;fs.writeFileSync(${JSON.stringify(join(dir, 'ready-'))}+process.pid,'ready');const end=Date.now()+5000;while(fs.readdirSync(${JSON.stringify(dir)}).filter(x=>x.startsWith('ready-')).length<2&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}return read.call(this,file,...args)};syncBuiltinESMExports();`)
  const urls = new Set()
  try {
    const run = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, [script, '--serve', '--no-open'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', fail)
      child.on('exit', code => {
        const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]
        if (url) urls.add(url)
        done({ code, out, url })
      })
    })
    const result = await Promise.all([run(), run()])
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
    querySelectorAll(selector) { return this.childNodes.flatMap(child => [...(selector === 'textarea[data-key]' && child.tag === 'textarea' && child.getAttribute('data-key') !== null ? [child] : []), ...child.querySelectorAll(selector)]) }
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

// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
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

const htmlRun = ({ file = '', inbox = {}, age = 0, lang = 'en', home = dir => dir } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-html-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, file)
    mkdirSync(join(dir, 'progress-inbox'))
    for (const [name, body] of Object.entries(typeof inbox === 'function' ? inbox(dir) : inbox)) {
      const target = join(dir, 'progress-inbox', name)
      writeFileSync(target, body)
      const at = new Date(Date.now() - (typeof age === 'function' ? age(name) : age))
      utimesSync(target, at, at)
    }
    // A static page is inspected from disk; the test never opens a browser.
    assert.ok(BOARD_SCRIPT.includes('openInBrowser(html,'))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT.replace('openInBrowser(html,', '((target, done) => done(false))(html,')}`)
    execFileSync(process.execPath, [script, '--html'], {
      env: { ...process.env, CLAUDE_PROGRESS_FILE: path, HOME: home(dir), USERPROFILE: home(dir) },
      encoding: 'utf8',
    })
    return readFileSync(join(dir, 'progress.html'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const HTML_TURN = 'codex-turn-1792152000-1.json'
const HTML_QUESTION = 'Use 100 or 300 a minute?'
const htmlTurn = answer => JSON.stringify({ session_id: 'demo-1', cwd: '/work/api-gateway', last_assistant_message: answer })

test('the HTML board shows pending questions with an empty progress file and cannot send replies', () => {
  for (const [lang, label, hint] of [
    ['en', 'Turns in the inbox not summed up yet', 'this page cannot send replies'],
    ['zh-TW', '收件匣裡還沒整理的回合', '請回到該 agent 的對話裡回覆；這個頁面不能傳送回覆。'],
    ['zh-CN', '收件箱里还没整理的回合', '请回到该 agent 的对话里回复；这个页面不能发送回复。'],
  ]) {
    const page = htmlRun({ inbox: { [HTML_TURN]: htmlTurn(HTML_QUESTION) }, lang })
    assert.ok(page.includes(label) && page.includes(hint), page)
    assert.ok(page.includes('api-gateway · codex'), page)
    assert.equal(page.split(HTML_QUESTION).length - 1, 1)
    assert.ok(page.includes('data-key="section:inbox" open'), page)
    assert.ok(!/Nothing needs you right now|<form|<textarea|<button|fetch\(/.test(page), page)
    assert.ok(/● 1<\/span>/.test(page), page)
  }
})

test('the HTML board keeps a stale inbox question visible until it is processed', () => {
  const page = htmlRun({ inbox: { [HTML_TURN]: htmlTurn(HTML_QUESTION) }, age: 7 * 24 * 60 * 60 * 1000 })
  assert.ok(page.includes(HTML_QUESTION) && page.includes('Turns in the inbox not summed up yet'), page)
})

test('the HTML board shows only the newest thirty inbox files', () => {
  const inbox = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [
    `codex-turn-1792152000-${i}.json`,
    JSON.stringify({ session_id: `demo-${i}`, cwd: '/work/api-gateway', last_assistant_message: `Use limit ${i}?` }),
  ]))
  const page = htmlRun({ inbox, age: name => Number(name.match(/-(\d+)\.json$/)[1]) * 1000 })
  for (let i = 0; i < 35; i++) assert.equal(page.includes(`Use limit ${i}?`), i < 30, page)
})

test('the HTML board skips malformed inbox files without losing a valid question', () => {
  const page = htmlRun({ inbox: { 'codex-turn-1792152000-2.json': '{ broken', [HTML_TURN]: htmlTurn(HTML_QUESTION) } })
  assert.ok(page.includes(HTML_QUESTION) && !page.includes('{ broken'), page)
  assert.ok(!htmlRun({ inbox: { [HTML_TURN]: '{ broken' } }).includes('data-key="section:inbox"'))
})

test('the HTML board escapes pending turn text and project names', () => {
  const page = htmlRun({ inbox: {
    [HTML_TURN]: JSON.stringify({ session_id: 'demo-1', cwd: '/work/<img "demo" &>', last_assistant_message: '<script>alert("demo")</script> & done?' }),
    'gemini-turn-1792152000-2.json': JSON.stringify({ session_id: 'demo-2', cwd: '/work/api-gateway', prompt_response: 'Use <demo> & "yes"?' }),
  } })
  assert.ok(page.includes('&lt;scriptalert(&quot;demo&quot;)&lt;/script &amp; done?'), page)
  assert.ok(page.includes('&lt;img &quot;demo&quot; &amp;&gt;'), page)
  assert.ok(page.includes('&lt;demo') && page.includes('&amp; &quot;yes&quot;?'), page)
  assert.ok(!/<script>alert|<img|<demo/.test(page), page)
})

// The CLI cannot read the plugin store's inboxDone; only a claimed file is excluded here.
test('the HTML board skips claimed inbox files while keeping the question in progress.md', () => {
  const page = htmlRun({
    file: FILE.replace('Per-key limit — 100 or 300 a minute?', HTML_QUESTION),
    inbox: { [`${HTML_TURN}.deadbeef-abc-1.taking`]: htmlTurn(HTML_QUESTION) },
  })
  assert.ok(!page.includes('data-key="section:inbox"'), page)
  const waiting = page.match(/data-key="section:waiting"[\s\S]*?<\/details>/)?.[0] ?? ''
  assert.equal(waiting.split(HTML_QUESTION).length - 1, 1, page)
})

test('the HTML board lists a question in both an agent block and the inbox like the terminal board and --serve', () => {
  const page = htmlRun({
    file: FILE.replace('Per-key limit — 100 or 300 a minute?', HTML_QUESTION),
    inbox: { [HTML_TURN]: htmlTurn(HTML_QUESTION) },
  })
  const pending = page.match(/data-key="section:inbox"[\s\S]*?<\/details>/)?.[0] ?? ''
  const waiting = page.match(/data-key="section:waiting"[\s\S]*?<\/details>/)?.[0] ?? ''
  assert.equal(pending.split(HTML_QUESTION).length - 1, 1, page)
  assert.equal(waiting.split(HTML_QUESTION).length - 1, 1, page)
  assert.ok(/● 2<\/span>/.test(page), page)
})

test('the HTML board redacts home paths and credentials before clipping pending questions', () => {
  const secret = `sk-${'a'.repeat(40)}`
  const page = htmlRun({
    home: dir => join(dir, 'demo-home'),
    inbox: dir => ({ [HTML_TURN]: htmlTurn(`Use ${join(dir, 'demo-home', 'private')} with ${secret} or wait?`) }),
  })
  assert.ok(page.includes('~') && page.includes('•••') && page.includes('or wait?'), page)
  assert.ok(!page.includes('demo-home') && !page.includes(secret), page)
})

test('the HTML board shows only the agent and project for a pending turn without a question', () => {
  const page = htmlRun({ inbox: {
    [HTML_TURN]: JSON.stringify({ session_id: 'demo-1', cwd: '/work/api-gateway', prompt: 'Private prompt contents', last_assistant_message: '' }),
    'gemini-turn-1792152000-2.json': JSON.stringify({ session_id: 'demo-2', cwd: '/work/api-gateway', prompt_response: 'Private reply contents.' }),
  } })
  assert.ok(page.includes('api-gateway · codex') && page.includes('api-gateway · gemini'), page)
  assert.ok(!page.includes('Private prompt contents') && !page.includes('Private reply contents'), page)
})

// `--chat` in a folder of its own, with the home folder, the temp folders and every XDG folder
// inside it, so no run can read or write the real ones. `home` is a path inside it. `change`
// edits the script's text first, to make it fail the way a bug in it would.
const chatRun = (args, { file = () => FILE, beside = {}, lang = 'en', isFolder = false, change = text => text, inbox = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-chat-'))
  try {
    const home = join(root, 'Jane Doe')
    const dirs = Object.fromEntries(['.claude', 'AppData', 'Local', 'Roaming', 'config', 'data', 'state', 'cache', 'run'].map(name => [name, join(home, name)]))
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    const path = join(dirs['.claude'], 'progress.md')
    if (!isFolder) writeFileSync(path, file(home))
    else mkdirSync(path)
    for (const [name, text] of Object.entries(beside)) writeFileSync(join(dirs['.claude'], name), text)
    mkdirSync(join(dirs['.claude'], 'progress-inbox'))
    for (const [name, body] of Object.entries(inbox)) writeFileSync(join(dirs['.claude'], 'progress-inbox', name), body)
    const script = join(dirs['.claude'], 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${change(BOARD_SCRIPT)}`)
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home, LOCALAPPDATA: dirs.Local, APPDATA: dirs.Roaming,
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.run,
      TMPDIR: dirs.run, TEMP: dirs.run, TMP: dirs.run,
      CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: '', NO_COLOR: '1',
    }
    const before = readdirSync(dirs['.claude']).sort()
    const ran = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 20000 })
    return { ...ran, home, path, wrote: readdirSync(dirs['.claude']).filter(name => !before.includes(name)), served: readdirSync(dirs.run) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const CHAT_PROGRESS = home => `# Progress

## api-gateway
<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=${WAITING_AT} -->
### Rate-limit the public endpoints
- [x] Added the token bucket middleware
- [?] Per-key limit — 100 or 300 a minute?
- [ ] Write the limit tests
<!-- /auto session=a1b2c3d4 -->

## docs-site
<!-- auto session=b2c3d4e5 agent=gemini state=working updated=${WRITTEN_AT} -->
### Fix the broken links
- [x] Read the list of pages
- [~] Open ${join(home, 'site', 'links.md')}, set OPENAI_API_KEY=sk-test1234567890abcdef and check https://ci.example.com/run?t=abc123&page=2
<!-- /auto session=b2c3d4e5 -->
`

test('--chat prints the board as plain text and starts nothing: no page, no browser, no link, no file written', () => {
  // --serve beside it would start a page and print its address; --chat comes first.
  for (const args of [['--chat'], ['--chat', '--serve'], ['--serve', '--chat', '--lan'], ['--chat', '--watch'], ['--chat', '--html'], ['--chat', '--keys', 'down x']]) {
    const ran = chatRun(args, { file: CHAT_PROGRESS })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.stdout.startsWith('Progress  ● 1 waiting  ▸ 1 in progress'), ran.stdout)
    assert.ok(ran.stdout.includes('● Waiting on you\n  api-gateway · codex › Rate-limit the public endpoints\n    [Choose] Per-key limit — 100 or 300 a minute?\n'), ran.stdout)
    assert.ok(ran.stdout.includes('\n▸ docs-site › Fix the broken links — next Open ~'), ran.stdout)
    assert.ok(ran.stdout.includes('set OPENAI_API_KEY=••• and check https://ci.example.com/run?page=2'), ran.stdout)
    assert.ok(!/127\.0\.0\.1|localhost|[?]t=|\u001b|board you can click/i.test(ran.stdout), ran.stdout)
    assert.equal(ran.stderr, '')
    assert.deepEqual([ran.wrote, ran.served], [[], []])
  }
})

test('--chat hides the home folder, with a space in its name, and the credentials it knows, in everything it prints', () => {
  const ran = chatRun(['--chat'], { file: CHAT_PROGRESS })
  const home = ran.home
  assert.ok(home.includes('Jane Doe'))
  assert.ok(!ran.stdout.includes(home) && !ran.stdout.includes('Jane Doe'), ran.stdout)
  assert.ok(!ran.stdout.includes('sk-test') && !ran.stdout.includes('abc123'), ran.stdout)
  // The file it cannot read is told in the same plain text, with its path hidden as well.
  const unreadable = chatRun(['--chat'], { isFolder: true })
  assert.equal(unreadable.status, 1)
  assert.ok(unreadable.stdout.includes('~') && unreadable.stdout.includes('progress.md') && unreadable.stdout.includes('EISDIR'), unreadable.stdout)
  // It only reads: it does not say, as the board does after a write, that files may already have changed.
  assert.ok(unreadable.stdout.includes('Nothing was changed') && !/may already have changed/.test(unreadable.stdout), unreadable.stdout)
  assert.ok(!unreadable.stdout.includes(unreadable.home) && !unreadable.stdout.includes('Jane Doe') && !unreadable.stderr.includes('Jane Doe'), unreadable.stdout + unreadable.stderr)
})

test('--chat that fails for a reason that is no file says so in one plain line with the home folder hidden, never as a stack trace', () => {
  // The journal call is made to throw an error that names the home folder, as a bug in it might.
  const call = 'doneToday(read('
  assert.ok(BOARD_SCRIPT.includes(call), 'the call this test breaks is no longer in the script')
  const broken = script => script.replace(call, '((...rest) => { throw new TypeError("cannot go on in " + process.env.HOME + "/notes.md") })(read(')
  for (const [lang, start] of [['en', 'The board could not be shown (cannot go on in ~/notes.md).'], ['zh-TW', '看板顯示不出來（cannot go on in ~/notes.md）。']]) {
    const ran = chatRun(['--chat', '--lang', lang], { file: CHAT_PROGRESS, change: broken })
    assert.equal(ran.status, 1, ran.stderr)
    assert.ok(ran.stdout.startsWith(start), ran.stdout)
    assert.equal(ran.stdout.trimEnd().split('\n').length, 1, ran.stdout)
    assert.ok(!ran.stdout.includes('Jane Doe') && !ran.stdout.includes(ran.home), ran.stdout)
    // No stack trace on either stream: it would carry the folders of the script and of the home.
    assert.ok(!/\n\s+at |board-chat-|node:internal|Error:/.test(ran.stdout + ran.stderr), ran.stdout + ran.stderr)
    assert.equal(ran.stderr, '')
    assert.deepEqual([ran.wrote, ran.served], [[], []])
  }
})

test('--chat hides a token in a waiting reply before its question is picked, so no piece of it reaches the chat', () => {
  const reply = (session, answer) => JSON.stringify({ session_id: session, cwd: '/h/.openclaw/workspace', last_assistant_message: answer })
  const token = ['ghp', '16C7e42F292c6912E7710c838347Ae178B4a'].join('_')
  const ran = chatRun(['--chat'], {
    file: CHAT_PROGRESS,
    inbox: {
      'openclaw-turn-2-1.json': reply('o1', `Done.\n\nShould I set it to ${token} in CI?`),
      'openclaw-turn-3-1.json': reply('o2', `Should I use postgres://app:${'x'.repeat(100)}/K7MDENG@dbhost as the URL for the staging database?`),
    },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.stdout.includes('Should I set it to ••• in CI?'), ran.stdout)
  assert.ok(ran.stdout.includes('Should I use postgres://•••@dbhost as the URL for the staging database?'), ran.stdout)
  // Not a piece of it, nor the token with its underscores taken out.
  for (const leak of [token.slice(4, 14), token.replace(/_/g, ''), 'xxxx', 'K7MDENG']) assert.ok(!ran.stdout.includes(leak), leak + '\n' + ran.stdout)
})

test('--chat leaves out a question marked answered, and a damaged answered list drops none', () => {
  const answered = JSON.stringify({ answered: ['a1b2c3d4 2 Per-key limit — 100 or 300 a minute?'] })
  const hidden = chatRun(['--chat'], { file: CHAT_PROGRESS, beside: { 'progress-answered.json': answered } })
  assert.ok(hidden.stdout.startsWith('Progress  ● 0 waiting'), hidden.stdout)
  assert.ok(!hidden.stdout.includes('Per-key limit') && !hidden.stdout.includes('Waiting on you'), hidden.stdout)
  assert.ok(hidden.stdout.includes('✓ Nothing needs you right now\n1 answered, hidden\n'), hidden.stdout)
  for (const broken of ['{', '', 'not json at all', '{"answered": "a1b2c3d4 2 Per-key limit — 100 or 300 a minute?"}', '{"answered": [1, null]}']) {
    const shown = chatRun(['--chat'], { file: CHAT_PROGRESS, beside: { 'progress-answered.json': broken } })
    assert.ok(shown.stdout.startsWith('Progress  ● 1 waiting'), `${broken}\n${shown.stdout}`)
    assert.ok(shown.stdout.includes('[Choose] Per-key limit — 100 or 300 a minute?'), `${broken}\n${shown.stdout}`)
    // Reading it did not write over it.
    assert.deepEqual(shown.wrote, [])
  }
})

test('--chat names what was done today from the journal, and keeps to one message however long the board is', () => {
  const pad = n => String(n).padStart(2, '0')
  const now = new Date()
  const stamp = (date, hour, minute) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const journal = `# Journal\n- ${stamp(now, 0, 0)} · docs-site · Fix the broken links · Read the list\n- ${stamp(yesterday, 23, 59)} · docs-site · Fix the broken links · Old step\n`
  const tasks = Array.from({ length: 80 }, (_, index) => `### Task ${pad(index + 1)} with a title that runs on a little\n- [~] Step two for task ${pad(index + 1)}, which takes a while to describe\n- [ ] Step three\n`).join('\n')
  const ran = chatRun(['--chat'], { file: home => `${CHAT_PROGRESS(home)}\n## big-project\n${tasks}`, beside: { [`progress-journal-${month}.md`]: journal } })
  assert.ok(ran.stdout.length <= 3500, String(ran.stdout.length))
  assert.ok(/\n\n\+\d+ more\n$/.test(ran.stdout), ran.stdout.slice(-200))
  // The questions stay when the tasks are cut.
  assert.ok(ran.stdout.includes('Per-key limit'), ran.stdout)
  const small = chatRun(['--chat'], { file: CHAT_PROGRESS, beside: { [`progress-journal-${month}.md`]: journal } })
  assert.ok(small.stdout.includes('\n\n  ✓ docs-site · Fix the broken links: Read the list\n'), small.stdout)
  assert.ok(!small.stdout.includes('Old step') && !/more\n$/.test(small.stdout), small.stdout)
  assert.ok(small.stdout.startsWith('Progress  ● 1 waiting  ▸ 1 in progress  ⚑ 0 due soon  ✓ 1 done today'), small.stdout)
  // In the language the board script was written for, or --lang.
  assert.ok(chatRun(['--chat', '--lang', 'zh-CN'], { file: CHAT_PROGRESS }).stdout.startsWith('进度  ● 1 等你'))
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

// The real --watch key handler on a pretend terminal: the file is changed (or not) right after
// the first screen is drawn, and the keys arrive before the next 2-second redraw, the way a press
// does when an agent writes between a draw and a key.
const watchPress = (initial, replacement, keys) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-watch-'))
  try {
    const path = join(dir, 'progress.md')
    const script = join(dir, 'agent-board.mjs')
    const preload = join(dir, 'preload.mjs')
    writeFileSync(path, initial)
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    writeFileSync(preload, `import fs from 'node:fs'
Object.defineProperty(process.stdin, 'isTTY', { value: true })
process.stdin.setRawMode = () => {}
const write = process.stdout.write.bind(process.stdout)
let drawn = false
process.stdout.write = function (text, ...rest) {
  const result = write(text, ...rest)
  if (!drawn && String(text).startsWith('\\x1b[2J\\x1b[H')) {
    drawn = true
    fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(replacement)})
    queueMicrotask(() => {
      for (const key of ${JSON.stringify(keys)}) process.stdin.emit('data', key)
      process.stdin.emit('data', 'q')
    })
  }
  return result
}
`)
    const out = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--watch'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000 })
    return { out, after: readFileSync(path, 'utf8'), dir }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const LINE_CHANGED = 'That line just changed; check the one chosen now and press again.'

test('the terminal board archives with a only the block it drew: another session’s block under the same title is left alone and named as changed', { timeout: 30_000 }, () => {
  const updated = ago(20 * 60 * 60 * 1000)
  const initial = `# Progress\n\n## synthetic\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=${updated} -->\n### Synthetic same-title task\n- [ ] Keep this task\n<!-- /auto session=a1b2c3d4 -->\n`
  const replacement = initial.replaceAll('a1b2c3d4', 'd4e5f6a7')
  const refused = watchPress(initial, replacement, ['a'])
  assert.equal(refused.after, replacement)
  assert.ok(refused.out.includes(LINE_CHANGED), refused.out)
  assert.ok(!refused.out.includes('Archived'), refused.out)
  // The block that was drawn, still there, goes to the archive as before.
  const archived = watchPress(initial, initial, ['a'])
  assert.ok(archived.out.includes('Archived “Synthetic same-title task”.'), archived.out)
  assert.ok(!archived.after.includes('a1b2c3d4'))
})

test('the terminal board ticks with x only the step it drew: a step that became next since is named as changed and left open', { timeout: 30_000 }, () => {
  const initial = `# Progress\n\n## synthetic\n### Synthetic manual task\n- [ ] Step one\n- [ ] Step two\n`
  const replacement = `# Progress\n\n## synthetic\n### Synthetic manual task\n- [x] Step one\n- [ ] Step two\n`
  const refused = watchPress(initial, replacement, ['x'])
  assert.ok(refused.out.split('\u001b[2J\u001b[H')[1].includes('Step one'))
  assert.equal(refused.after, replacement)
  assert.ok(refused.out.includes(LINE_CHANGED), refused.out)
  // Nothing changed between the draw and the key: the step shown is ticked.
  const ticked = watchPress(initial, initial, ['x'])
  assert.ok(ticked.after.includes('- [x] Step one') && ticked.after.includes('- [ ] Step two'), ticked.after)
  assert.ok(ticked.out.includes('Done: “Step one”.'), ticked.out)
})

test('the terminal board archives with a only the hand-kept task it drew: once the first of two with the same words has gone, the one that took its key is left and named as changed', { timeout: 30_000 }, () => {
  const initial = `# Progress\n\n## Home\n### Weekly review\n- [ ] Write notes\n\n### Weekly review\n- [x] Call Bob\n- [ ] Write notes\n`
  const replacement = `# Progress\n\n## Home\n### Weekly review\n- [x] Call Bob\n- [ ] Write notes\n`
  const refused = watchPress(initial, replacement, ['a'])
  assert.equal(refused.after, replacement)
  assert.ok(refused.out.includes(LINE_CHANGED), refused.out)
  assert.ok(!refused.out.includes('Archived'), refused.out)
  // Nothing gone since the draw: the first one is archived, and only it.
  const archived = watchPress(initial, initial, ['a'])
  assert.ok(archived.out.includes('Archived “Weekly review”.'), archived.out)
  assert.equal(archived.after.split('### Weekly review').length - 1, 1, archived.after)
  assert.ok(archived.after.includes('Call Bob'), archived.after)
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
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand, XDG_RUNTIME_DIR: run, ...env },
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
  const rowOf = async title => (await rows()).find(row => row.title === title)
  const keyOf = async title => (await rowOf(title))?.key
  const close = async () => {
    if (child.exitCode === null) await call('POST', '/api/close', { body: {} }).catch(() => undefined)
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))])
    if (code === 'still running') child.kill()
    rmSync(dir, { recursive: true, force: true })
    return code
  }
  return { dir, path, url, port, token, call, rows, rowOf, keyOf, close, exited, served: servedAt(run, path) }
}

test('the terminal and served boards show only the newest thirty inbox files', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const inbox = join(board.dir, 'progress-inbox')
    mkdirSync(inbox)
    const now = Date.now()
    for (let i = 0; i < 35; i++) {
      const file = join(inbox, `codex-turn-1792152000-${i}.json`)
      writeFileSync(file, JSON.stringify({ session_id: `demo-${i}`, cwd: '/work/api-gateway', last_assistant_message: `Use limit ${i}?` }))
      const at = new Date(now - i * 1000)
      utimesSync(file, at, at)
    }
    const terminal = execFileSync(process.execPath, [join(board.dir, 'agent-board.mjs')], {
      env: { ...process.env, CLAUDE_PROGRESS_FILE: board.path, NO_COLOR: '1' },
      encoding: 'utf8',
    })
    const served = (await board.call('GET', '/api/board')).json().model.turns
    assert.equal(served.length, 30)
    for (let i = 0; i < 35; i++) {
      assert.equal(terminal.includes(`Use limit ${i}?`), i < 30, terminal)
      assert.equal(served.some(turn => turn.text === `Use limit ${i}?`), i < 30, JSON.stringify(served))
    }
  } finally {
    await board.close()
  }
})

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

test('ticking and tidying from the page write progress.md the way the pane does, and a pasted block is merged into it', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { path, call, rowOf } = board
    // The page sends the step it showed; once that step is done, the next one is not ticked in its place.
    const { key: fabrikam, fp } = await rowOf('Fabrikam fellowship')
    assert.equal((await call('POST', '/api/act', { body: { key: fabrikam, type: 'tick', text: 'Draft the statement', fp } })).status, 409)
    const ticked = await call('POST', '/api/act', { body: { key: fabrikam, type: 'tick', text: 'Ask two referees', fp } })
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
    const { path, call, keyOf, rowOf } = board
    const before = readFileSync(path, 'utf8')
    const ticked = await call('POST', '/api/act', { body: { key: await keyOf('Fabrikam fellowship'), type: 'tick', text: 'Ask two referees', fp: (await rowOf('Fabrikam fellowship')).fp } })
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
    const { call, rowOf, rows } = board
    const { key, fp } = await rowOf('Pick the cache')
    assert.equal((await rows()).find(row => row.key === key)?.send, 'send')
    // A page drawn when another session held that line does not send into this one.
    const stale = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'c0ffee12', fp } })
    assert.equal(stale.status, 409)
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    // The send is taken at once; the answer comes later, with the board.
    // A reply written under a question the task no longer asks does not go either.
    const reworded = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Which port?', fp } })
    assert.equal(reworded.status, 409)
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    const first = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Redis or Memcached?', fp } })
    assert.equal(first.status, 202, first.body)
    assert.equal(first.json().note, 'Sent to grok · Pick the cache; its reply shows here when it comes (it can take a few minutes).')
    assert.equal((await rows()).find(row => row.key === key)?.isSending, true)
    const second = await call('POST', '/api/act', { body: { key, type: 'send', text: 'Memcached', session: 'b2c3d4e5', asked: 'Redis or Memcached?', fp } })
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

test('a press on the page for a task whose block another session took under the same title is refused, and nothing is archived until the page draws the block that is there now', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { call, path, rowOf } = board
    const row = await rowOf('Pick the cache')
    assert.equal(row.canArchive, true)
    // Another Grok session replaces the block between the page's draw and the press.
    const swapped = readFileSync(path, 'utf8').replaceAll('b2c3d4e5', 'd4e5f6a7').replaceAll(GROK_ID, '22222222-2222-2222-2222-222222222222')
    writeFileSync(path, swapped)
    const press = fp => call('POST', '/api/act', { body: { key: row.key, type: 'archive', text: '', session: row.session, fp } })
    const refused = await press(row.fp)
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().note, LINE_CHANGED)
    assert.equal(readFileSync(path, 'utf8'), swapped)
    // A page from before the fingerprint existed sends none: refused the same way.
    assert.equal((await press(undefined)).status, 409)
    assert.equal(readFileSync(path, 'utf8'), swapped)
    // Drawn again, the line has a fingerprint of its own, and the press archives that block.
    const now = await rowOf('Pick the cache')
    assert.notEqual(now.fp, row.fp)
    const archived = await press(now.fp)
    assert.equal(archived.status, 200, archived.body)
    assert.ok(!readFileSync(path, 'utf8').includes('d4e5f6a7'))
  } finally {
    await board.close()
  }
})

test('a tick on the page for a hand-kept question that was reworded since the page drew it is refused, and the reworded step stays open', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { call, path } = board
    const model = async () => (await call('GET', '/api/board')).json().model
    const ask = async () => (await model()).asks.find(one => one.project === 'Job search')
    const text = () => readFileSync(path, 'utf8')
    writeFileSync(path, text().replace('- [ ] Ask two referees', '- [?] Ask two referees'))
    const drawn = await ask()
    assert.equal(drawn.text, 'Ask two referees')
    const reworded = text().replace('- [?] Ask two referees', '- [?] Submit the replacement application')
    writeFileSync(path, reworded)
    const press = fp => call('POST', '/api/act', { body: { key: drawn.key, type: 'tick', text: '', session: '', fp } })
    const refused = await press(drawn.fp)
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().note, LINE_CHANGED)
    assert.equal(text(), reworded)
    // Drawn again, the page ticks the step it now shows.
    const now = await ask()
    assert.equal(now.key, drawn.key)
    assert.notEqual(now.fp, drawn.fp)
    assert.equal((await press(now.fp)).status, 200)
    assert.ok(text().includes('- [x] Submit the replacement application'))
  } finally {
    await board.close()
  }
})

test('a second press on the page for the first of two hand-kept tasks with the same words is refused once it is archived, and the second task stays', { timeout: 30_000 }, async () => {
  const board = await page(`\n## Home\n### Weekly review\n- [ ] Write notes\n\n### Weekly review\n- [x] Call Bob\n- [ ] Write notes\n`)
  try {
    const { call, path, rows } = board
    const twins = (await rows()).filter(row => row.title === 'Weekly review')
    assert.equal(twins.length, 2)
    const [first] = twins
    const press = () => call('POST', '/api/act', { body: { key: first.key, type: 'archive', text: '', session: '', fp: first.fp } })
    // A double click sends the same press twice, with what the page drew.
    const archived = await press()
    assert.equal(archived.status, 200, archived.body)
    assert.equal(readFileSync(path, 'utf8').split('### Weekly review').length - 1, 1)
    const afterFirst = readFileSync(path, 'utf8')
    const refused = await press()
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().note, LINE_CHANGED)
    assert.equal(readFileSync(path, 'utf8'), afterFirst)
    assert.ok(afterFirst.includes('Call Bob'))
    // Drawn again, the task that is left has a fingerprint of its own.
    const left = (await rows()).find(row => row.title === 'Weekly review')
    assert.equal(left.key, first.key)
    assert.notEqual(left.fp, first.fp)
  } finally {
    await board.close()
  }
})

// The page's own script run against a minimal DOM, to see what it keeps across a redraw and what
// it sends. `redraw` hands it the next board, as the page's next poll would get it.
const pageDom = async (html, first) => {
  const nodes = new Map()
  class Element {
    constructor(tag) {
      this.tag = tag
      this.childNodes = []
      this.attributes = {}
      this.events = {}
      this.value = ''
      this.text = ''
      this.style = {}
    }
    set textContent(value) {
      this.text = value
      this.childNodes = []
    }
    get textContent() {
      return this.text + this.childNodes.map(child => child.textContent).join('')
    }
    appendChild(child) {
      this.childNodes.push(child)
      return child
    }
    removeChild(child) {
      this.childNodes = this.childNodes.filter(one => one !== child)
    }
    setAttribute(name, value) {
      this.attributes[name] = value
    }
    getAttribute(name) {
      return this.attributes[name] ?? null
    }
    addEventListener(name, run) {
      this.events[name] = run
    }
    querySelectorAll() {
      return this.childNodes.flatMap(child => [...(child.tag === 'textarea' && child.getAttribute('data-key') !== null ? [child] : []), ...child.querySelectorAll()])
    }
    click() {
      if (!this.disabled) this.events.click?.()
    }
    focus() {}
    setSelectionRange() {}
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id))
    return nodes.get(id)
  }
  get('words').textContent = html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1]
  const document = {
    getElementById: get,
    createElement: tag => new Element(tag),
    createTextNode: text => {
      const node = new Element('text')
      node.textContent = text
      return node
    },
    querySelector: get,
    activeElement: null,
  }
  let model = first
  let scheduled
  const requests = []
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(found => found[1]).find(code => code.includes('(function ()'))
  runInNewContext(script, {
    document,
    location: { search: '?t=x' },
    URLSearchParams,
    navigator: {},
    window: {},
    setTimeout: run => {
      scheduled = run
      return 1
    },
    clearTimeout: () => {},
    fetch: async (target, options) => {
      if (target === '/api/board') return { ok: true, json: async () => ({ model, now: 1 }) }
      requests.push({ path: target, body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ note: '' }) }
    },
  })
  const flush = () => new Promise(done => setImmediate(done))
  await flush()
  const buttons = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...buttons(child)])
  return {
    boxes: () => get('board').querySelectorAll(),
    send: () => buttons(get('board')).find(button => button.textContent === 'Send to grok'),
    requests,
    flush,
    redraw: async next => {
      model = next
      scheduled()
      await flush()
    },
  }
}

test('a reply typed for one session is dropped when the box is redrawn for another session under the same title, and a new reply goes to the session shown', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const { call, path, rowOf, token } = board
    const html = (await call('GET', `/?t=${token}`, { headers: { 'x-board-token': '' } })).body
    const model = async () => (await call('GET', '/api/board')).json().model
    const first = await model()
    const dom = await pageDom(html, first)
    const [boxA] = dom.boxes()
    boxA.value = 'Synthetic draft meant for session A'
    // The same session drawn again, with a count changed: what is typed stays.
    await dom.redraw({ ...first, counts: { ...first.counts, today: first.counts.today + 1 } })
    assert.equal(dom.boxes()[0].value, 'Synthetic draft meant for session A')
    // Session A leaves and a second session takes the title while the text is still in the box.
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('b2c3d4e5', 'd4e5f6a7').replaceAll(GROK_ID, '22222222-2222-2222-2222-222222222222'))
    const second = await model()
    await dom.redraw(second)
    const [boxB] = dom.boxes()
    assert.equal(boxB.value, '')
    // Send with nothing in the box sends nothing.
    dom.send().click()
    await dom.flush()
    assert.equal(dom.requests.length, 0)
    // What is typed now goes to the session shown, with the fingerprint of the line shown.
    boxB.value = 'Synthetic reply for session B'
    dom.send().click()
    await dom.flush()
    const row = await rowOf('Pick the cache')
    assert.equal(dom.requests.length, 1)
    assert.deepEqual([dom.requests[0].path, dom.requests[0].body.session, dom.requests[0].body.fp], ['/api/act', 'd4e5f6a7', row.fp])
    const sent = await call('POST', '/api/act', { body: dom.requests[0].body })
    assert.equal(sent.status, 202, sent.body)
    // The agent stand-in answers after a second; the page is not closed while it is on its way.
    for (let tries = 0; tries < 50 && (await call('GET', '/api/board')).json().replies.length === 0; tries++) await new Promise(done => setTimeout(done, 200))
    assert.equal(JSON.parse(readFileSync(join(board.dir, 'grok-ran.json'), 'utf8')).args[1], '22222222-2222-2222-2222-222222222222')
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
    url = first.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1] ?? null
    assert.ok(url, first)
    assert.ok(first.startsWith('Progress  ● 1 waiting'), first)
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

const pause = ms => new Promise(done => setTimeout(done, ms))

// Asks the page at that address to close, and waits for its address file to go.
const closeAt = async (url, served) => {
  const { port, searchParams } = new URL(url)
  await new Promise(done => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/close', headers: { host: `127.0.0.1:${port}`, 'x-board-token': searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
    req.on('error', done)
    req.end('{}')
  })
  for (let tries = 0; existsSync(served) && tries < 50; tries++) await pause(100)
}

// A page whose agent stand-in writes down each run and holds it until `release` is written (or
// 8 seconds pass), like a long agent turn; and the `--serve` of a copy of its script beside it.
const holdingPage = async () => {
  const hold = mkdtempSync(join(tmpdir(), 'board-hold-'))
  const stand = join(hold, 'grok-stand-in.mjs')
  const calls = join(hold, 'calls.jsonl')
  const gate = join(hold, 'release')
  writeFileSync(stand, `import { appendFileSync, existsSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
const end = Date.now() + 8000
const timer = setInterval(() => { if (existsSync(${JSON.stringify(gate)}) || Date.now() > end) { clearInterval(timer); process.stdout.write('Redis it is.\\n'); process.exit(0) } }, 25)
`)
  const agents = { AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand }
  const board = await page('', agents)
  const script = join(board.dir, 'agent-board.mjs')
  const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: join(board.dir, 'run'), ...agents }
  return {
    board,
    ran: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    // A new copy of the script, as after an update: another build time, so --serve means to replace the page.
    update: () => {
      const { atime, mtimeMs } = statSync(script)
      utimesSync(script, atime, new Date(mtimeMs + 5000))
    },
    serve: () => new Promise((done, fail) => execFile(process.execPath, [script, '--serve', '--no-open'], { env, encoding: 'utf8', timeout: 30_000 }, (error, out) => (error ? fail(error) : done(out)))),
    // Lets the reply go, waits until the page has none in flight, and closes it if it is still there.
    stop: async () => {
      writeFileSync(gate, 'go')
      for (let tries = 0; tries < 100; tries++) {
        const ping = await board.call('GET', '/api/ping').catch(() => null)
        if (ping === null || ping.json().sending === 0) break
        await pause(50)
      }
      await board.close()
      rmSync(hold, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
    release: () => writeFileSync(gate, 'go'),
  }
}

test('a newer --serve does not start a second page while the page it would replace is sending a reply, shows that page with a note, and replaces it once the reply is in', { timeout: 60_000 }, async () => {
  const held = await holdingPage()
  const { board } = held
  const urls = []
  try {
    const drawn = await board.rowOf('Pick the cache')
    const reply = { key: drawn.key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Redis or Memcached?', fp: drawn.fp }
    assert.equal((await board.call('POST', '/api/act', { body: reply })).status, 202)
    held.update()
    const out = await held.serve()
    // The page that is sending is the only address shown, with the note above it, and no second
    // page took its place in the address file.
    assert.deepEqual(out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/g), [board.url.href], out)
    assert.ok(out.includes('A reply may still be on its way to an agent, so the board page that is already open is kept'), out)
    assert.ok(out.trimEnd().endsWith(board.url.href), out)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, board.url.href)
    // Another reply to that session meets the one in flight; only one run of the agent started.
    const second = await board.call('POST', '/api/act', { body: { ...reply, text: 'Memcached' } })
    assert.equal(second.status, 409)
    assert.equal(held.ran().length, 1)
    // The address file 0.19.0 left beside progress.md is kept the same way while its page sends.
    const beside = join(board.dir, 'progress-serve.json')
    renameSync(board.served, beside)
    const old = await held.serve()
    assert.deepEqual(old.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/g), [board.url.href], old)
    assert.ok(existsSync(beside) && !existsSync(board.served))
    renameSync(beside, board.served)
    // Once the reply is in, the page agrees to close and the newer copy starts its own.
    held.release()
    for (let tries = 0; (await board.call('GET', '/api/ping')).json().sending !== 0 && tries < 100; tries++) await pause(50)
    const next = await held.serve()
    const url = next.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1]
    assert.ok(url, next)
    urls.push(url)
    assert.notEqual(url, board.url.href)
    assert.ok(!next.includes('already open is kept'), next)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
    assert.equal(await Promise.race([board.exited, pause(5000).then(() => 'still running')]), 0)
  } finally {
    for (const url of urls) await closeAt(url, board.served)
    await held.stop()
  }
})

test('an address file naming a dead process, or a running one with nothing at its port, does not keep the next --serve from starting a page', { timeout: 60_000 }, async () => {
  // 999999 is a number no process has. The test's own is one that runs, as a number a restarted
  // computer gave to another program does.
  for (const pid of [999999, process.pid]) {
    const board = serveIn()
    const port = await freePort()
    const stale = `http://127.0.0.1:${port}/?t=gone`
    writeFileSync(board.served, JSON.stringify({ pid, port, url: stale, path: board.path, built: '' }))
    const urls = []
    try {
      const out = await board.serve()
      urls.push(board.urlOf(out))
      assert.ok(urls[0], out)
      assert.notEqual(urls[0], stale)
      assert.ok(!out.includes('already open is kept'), out)
      assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, urls[0])
    } finally {
      await board.end(urls)
    }
  }
})

test('a page whose process runs and whose port takes the connection but says nothing is shown with the note, and no second page starts', { timeout: 60_000 }, async () => {
  const board = serveIn()
  const sockets = new Set()
  const quiet = createNetServer(socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
  })
  await new Promise(done => quiet.listen(0, '127.0.0.1', done))
  const { port } = quiet.address()
  const stale = `http://127.0.0.1:${port}/?t=quiet`
  writeFileSync(board.served, JSON.stringify({ pid: process.pid, port, url: stale, path: board.path, built: '' }))
  try {
    const out = await board.serve()
    assert.equal(board.urlOf(out), stale, out)
    assert.ok(out.includes('A reply may still be on its way to an agent, so the board page that is already open is kept'), out)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, stale)
  } finally {
    for (const socket of sockets) socket.destroy()
    quiet.close()
    rmSync(board.served, { force: true })
    await board.end([])
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
    const { call, port, token, keyOf, rowOf } = board
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
    const seen = (await fetchAt(host, lanPort, 'GET', '/api/board', { 'x-board-token': phone })).json()
    assert.equal(seen.model.groups.flatMap(group => group.rows).find(row => row.title === 'Pick the cache')?.send, 'open')
    const key = await keyOf('Pick the cache')
    const sent = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { key, type: 'send', text: 'Redis', session: 'b2c3d4e5' })
    assert.equal(sent.status, 409)
    assert.equal(sent.json().note, "A reply to grok runs a program on the computer, so it is sent from the computer's own page. You can copy the answer here.")
    assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
    // A tick from the phone is written the way the computer's page writes one.
    const fabrikam = await rowOf('Fabrikam fellowship')
    const ticked = await fetchAt(host, lanPort, 'POST', '/api/act', { 'x-board-token': phone }, { key: fabrikam.key, type: 'tick', text: 'Ask two referees', fp: fabrikam.fp })
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

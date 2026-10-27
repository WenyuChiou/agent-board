// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { registerHooks } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { boardRun, geminiBoardCommand, normalizeCommandPath, opencodeBoardCommand } from '../hooks/board-commands.ts'
import { RELEASED } from '../hooks/released.ts'
import { liveBoardScript } from '../hooks/live-page.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'
import { immutableQuestionFiles } from '../scripts/question-files.ts'
import { recentInboxFiles } from '../scripts/inbox-files.ts'
import { serverMemoryArgs } from '../scripts/server-runtime.ts'
import { isPrivateRuntimeSddl } from '../scripts/runtime-folder.ts'
import { AGENT_ICONS } from '../hooks/agent-icons.ts'

const TORN_NOW = Date.parse('2026-10-20T12:00:00Z')
const tornDay = () => '# Progress\r\n\r\n## Synthetic day\r\n### Hand task alpha\r\n- [ ] Plan\r\n\r\n### Hand task beta\r\n- [ ] Review\r\n\r\n' +
  ['codex', 'cursor', 'gemini', 'grok', 'opencode', 'hermes', 'claude'].map((agent, i) =>
    `<!-- auto session=${10000000 + i} agent=${agent} state=working updated=2026-10-20T12:00:00Z -->\r\n### Day task ${i + 1}\r\n- [ ] Next step\r\n${i === 6 ? '<!-- /auto se' : `<!-- /auto session=${10000000 + i} -->\r\n`}`,
  ).join('\r\n')
const tornFiles = dir => ({ files: Object.fromEntries(readdirSync(dir).filter(name => name === 'progress.md' || name.startsWith('progress.md.torn-')).map(name => [name, readFileSync(join(dir, name))])) })
const tornChange = text => `Date.now = () => ${TORN_NOW}\n${text}`

test('L5 torn tail: the board warns in one line and still shows every complete block', async () => {
  const file = tornDay()
  const warning = 'progress.md has a cut-off marker line; 1 task may be hidden'
  for (const args of [[], ['--chat'], ['--keys', '']]) {
    const ran = chatRun(args, { file: () => file, change: tornChange })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout.split(warning).length - 1, 1, ran.stdout)
    for (const title of ['Hand task alpha', 'Hand task beta', ...Array.from({ length: 7 }, (_, i) => `Day task ${i + 1}`)]) assert.ok(ran.stdout.includes(title), ran.stdout)
  }
  for (const [lang, words] of [['en', warning], ['zh-TW', 'progress.md 有一行標記未寫完，可能有 1 項工作未顯示'], ['zh-CN', 'progress.md 有一行标记未写完，可能有 1 项工作未显示']]) {
    const ran = chatRun(['--chat'], { file: () => file, lang, change: tornChange })
    assert.equal(ran.stdout.split(words).length - 1, 1, ran.stdout)
  }
  const watched = chatRun(['--watch'], { file: () => file, change: tornChange, preload: `const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => { const result = write(chunk, ...rest); if (String(chunk).includes('task may be hidden')) process.exit(0); return result }` })
  assert.equal(watched.status, 0, watched.stderr)
  assert.equal(watched.stdout.split(warning).length - 1, 1)
  const html = htmlRun({ file, now: TORN_NOW })
  assert.equal(html.split(warning).length - 1, 1)
  for (let i = 1; i <= 7; i++) assert.ok(html.includes(`Day task ${i}`))
  const board = await page(file, {}, [], TORN_NOW)
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    assert.equal(model.warning, warning)
    for (let i = 1; i <= 7; i++) assert.ok([...model.groups.flatMap(group => group.rows), ...model.stopped].some(row => row.title === `Day task ${i}`))
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const dom = await pageDom(html, model)
    assert.equal(dom.node('board').textContent.split(warning).length - 1, 1)
  } finally { await board.close() }
})

test('an ordinary comment that starts with the word auto hides its lines as before and shows no warning', () => {
  const file = '## P\n### Keep me\n<!-- auto archive of old work\n## Old\n### Old task\n-->\n'
  for (const args of [[], ['--chat'], ['--keys', '']]) {
    const board = chatRun(args, { file: () => file, change: tornChange })
    assert.equal(board.status, 0, board.stderr)
    assert.ok(board.stdout.includes('Keep me'), board.stdout)
    assert.ok(!board.stdout.includes('Old task') && !board.stdout.includes('may be hidden'), board.stdout)
  }
  for (const [args, input] of [
    [['--codex-event'], { session_id: 'synthetic-ordinary-239', hook_event_name: 'SessionStart' }],
    [['--agent-status', '--agent', 'gemini'], { session_id: 'synthetic-ordinary-239', state: 'working' }],
    [['--codex-report', '--session', 'synthetic-ordinary-239'], { project: 'P', title: 'New report', state: 'working', steps: ['- [ ] Next'] }],
  ]) {
    const ran = chatRun(args, { file: () => file, input: JSON.stringify(input), inspect: tornFiles })
    assert.equal(ran.status, 0, ran.stderr)
    assert.deepEqual(ran.files['progress.md'].subarray(0, Buffer.byteLength(file)), Buffer.from(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
    const board = chatRun([], { file: () => ran.files['progress.md'], change: tornChange })
    assert.equal(board.status, 0, board.stderr)
    assert.ok(board.stdout.includes('Keep me'), board.stdout)
    assert.ok(!board.stdout.includes('Old task') && !board.stdout.includes('may be hidden'), board.stdout)
  }
})

test('a cut marker in the middle of the file is named without saying the end is cut', () => {
  const file = '## P\n### Earlier task\n<!-- auto se\n## Later\n### Later task\n- [ ] Next\n'
  for (const [lang, warning] of [
    ['en', 'progress.md has a cut-off marker line; 1 task may be hidden'],
    ['zh-TW', 'progress.md 有一行標記未寫完，可能有 1 項工作未顯示'],
    ['zh-CN', 'progress.md 有一行标记未写完，可能有 1 项工作未显示'],
  ]) {
    const board = chatRun(['--chat'], { file: () => file, lang, change: tornChange })
    assert.equal(board.status, 0, board.stderr)
    assert.equal(board.stdout.split(warning).length - 1, 1, board.stdout)
    assert.ok(board.stdout.includes('Earlier task') && board.stdout.includes('Later task'), board.stdout)
    assert.doesNotMatch(board.stdout, /The end|結尾|结尾/)
  }
})

test('L5 torn tail: a reporter append repairs the tail or reports why, never fails silently', () => {
  for (const [args, payload] of [
    [['--codex-event'], { session_id: 'synthetic-codex-239', hook_event_name: 'SessionStart' }],
    [['--agent-status', '--agent', 'gemini'], { session_id: 'synthetic-gemini-239', state: 'working' }],
  ]) {
    const file = tornDay()
    const ran = chatRun(args, { file: () => file, input: JSON.stringify(payload), inspect: tornFiles })
    assert.equal(ran.status, 0, ran.stderr)
    const repaired = ran.files['progress.md'].toString('utf8')
    assert.ok(repaired.startsWith(file.slice(0, -'<!-- /auto se'.length)))
    assert.ok(repaired.includes('<!-- /auto session=10000006 -->'))
    assert.ok(repaired.includes('source='))
    const failed = chatRun(args, { file: () => file, input: JSON.stringify(payload), inspect: tornFiles, preload: questionFault(`const open = fs.openSync
fs.openSync = (file, ...rest) => { if (String(file).includes('.torn-')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return open(file, ...rest) }`) })
    assert.equal(failed.status, 1)
    assert.equal(failed.stderr.trim().split('\n').length, 1, failed.stderr)
    assert.match(failed.stderr, /report could not be saved.*EACCES/i)
    assert.equal(failed.files['progress.md'].toString('utf8'), file)
  }
})

test('a cut end marker with later blocks after it still lets reporters write and keeps the file\'s bytes', () => {
  const file = tornDay() + '\r\n\r\n## Later project\r\n<!-- auto session=abcdef12 agent=cursor state=working -->\r\n### Later complete task\r\n- [ ] Preserve\r\n<!-- /auto session=abcdef12 -->\r\n### Later hand task\r\n- [ ] Preserve too\r\n'
  for (const [args, payload] of [
    [['--codex-event'], { session_id: 'synthetic-later-239', hook_event_name: 'SessionStart' }],
    [['--agent-status', '--agent', 'gemini'], { session_id: 'synthetic-later-239', state: 'working' }],
    [['--codex-report', '--session', 'synthetic-later-239'], { project: 'Later report', title: 'New report', state: 'working', steps: ['- [ ] Next'] }],
  ]) {
    const ran = chatRun(args, { file: () => file, input: JSON.stringify(payload), inspect: tornFiles })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stderr, '')
    assert.deepEqual(ran.files['progress.md'].subarray(0, Buffer.byteLength(file)), Buffer.from(file))
    assert.ok(ran.files['progress.md'].length > Buffer.byteLength(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
    const board = chatRun([], { file: () => ran.files['progress.md'], change: tornChange })
    assert.equal(board.status, 0, board.stderr)
    assert.ok(board.stdout.includes('Later complete task') && board.stdout.includes('Later hand task'), board.stdout)
    assert.match(board.stdout, /cut-off marker line/)
  }
})

test('an old-style comment that starts like an auto marker still lets reporters write', () => {
  for (const comment of ['<!-- auto archive of old work\n## Old\n-->\n', '<!-- auto session=abcdef12 agent=aider\n### Open task\n- [ ] Keep\n<!-- /auto session=abcdef12 -->\n']) {
    const file = `## P\n### Earlier task\n- [ ] Next\n${comment}`
    for (const [args, payload] of [
      [['--codex-event'], { session_id: 'synthetic-comment-239', hook_event_name: 'SessionStart' }],
      [['--agent-status', '--agent', 'gemini'], { session_id: 'synthetic-comment-239', state: 'working' }],
    ]) {
      const ran = chatRun(args, { file: () => file, input: JSON.stringify(payload), inspect: tornFiles })
      assert.equal(ran.status, 0, ran.stderr)
      assert.deepEqual(ran.files['progress.md'].subarray(0, Buffer.byteLength(file)), Buffer.from(file))
      assert.ok(ran.files['progress.md'].toString('utf8').includes('source='))
      assert.deepEqual(Object.keys(ran.files), ['progress.md'])
      const board = chatRun([], { file: () => ran.files['progress.md'], change: tornChange })
      assert.equal(board.status, 0, board.stderr)
      assert.ok(board.stdout.includes('Earlier task'), board.stdout)
      if (comment.includes('Open task')) assert.ok(board.stdout.includes('Open task'), board.stdout)
    }
  }
})

test('a failed fragment save leaves no extra file next to the board', () => {
  for (const fault of [
    `const open = fs.openSync
const fragments = new Set()
fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (String(file).includes('.torn-')) fragments.add(fd); return fd }
const write = fs.writeFileSync
fs.writeFileSync = (file, data, ...args) => { if (fragments.has(file)) { write(file, data.subarray(0, 1)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }; return write(file, data, ...args) }`,
    `fs.fsyncSync = () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }) }`,
    `const read = fs.readFileSync
fs.readFileSync = (file, ...args) => { if (String(file).includes('.torn-')) throw Object.assign(new Error('read failed'), { code: 'EIO' }); return read(file, ...args) }`,
    `const read = fs.readFileSync
fs.readFileSync = (file, ...args) => String(file).includes('.torn-') ? Buffer.from('wrong bytes') : read(file, ...args)`,
    `const rename = fs.renameSync
fs.renameSync = (from, to) => { if (String(to).endsWith('progress.md')) throw Object.assign(new Error('rename failed'), { code: 'EACCES' }); return rename(from, to) }`,
  ]) {
    const file = tornDay()
    const ran = chatRun(['--codex-event'], { file: () => file, input: JSON.stringify({ session_id: 'synthetic-cleanup-239', hook_event_name: 'SessionStart' }), inspect: tornFiles, preload: questionFault(fault) })
    assert.equal(ran.status, 1, ran.stderr)
    assert.equal(ran.stderr.trim().split('\n').length, 1, ran.stderr)
    assert.deepEqual(ran.files['progress.md'], Buffer.from(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
    assert.ok(!ran.wrote.some(name => name.startsWith('progress.md.')), ran.wrote.join('\n'))
  }
})

test('a refused fragment save says nothing changed in every language', () => {
  for (const [lang, message] of [['en', 'nothing changed'], ['zh-TW', '沒有改任何東西'], ['zh-CN', '没有改动任何内容']]) {
    const file = tornDay()
    const ran = chatRun(['--codex-event'], { lang, file: () => file, input: JSON.stringify({ session_id: 'synthetic-refusal-239', hook_event_name: 'SessionStart' }), inspect: tornFiles, preload: questionFault(`const read = fs.readFileSync
fs.readFileSync = (file, ...args) => String(file).includes('.torn-') ? Buffer.from('wrong bytes') : read(file, ...args)`) })
    assert.equal(ran.status, 1)
    assert.ok(ran.stderr.includes(message), ran.stderr)
    assert.deepEqual(ran.files['progress.md'], Buffer.from(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
  }
})

test('an empty baked progress path uses the usual progress file', () => {
  const ran = chatRun([], { change: text => `globalThis.AGENT_BOARD.path = ''\n${text}` })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.stdout.includes('Rate-limit the public endpoints'), ran.stdout)
})

test('a torn tail keeps every byte of the torn fragment in a file beside progress.md', () => {
  for (const fragment of [Buffer.from('<!-- /auto se'), Buffer.from('<!-- auto session=partial agent=codex -->\r\n### 還沒寫完\r\n- [ ] Keep this\r\n'), Buffer.concat([Buffer.from('<!-- auto session=partial agent=codex -->\n### Cut UTF-8 '), Buffer.from([0xe4, 0xb8])])]) {
    const prefix = tornDay().slice(0, -'<!-- /auto se'.length) + '<!-- /auto session=10000006 -->\r\n\r\n'
    const file = Buffer.concat([Buffer.from(prefix), fragment])
    const ran = chatRun(['--codex-event'], { file: () => file, input: JSON.stringify({ session_id: 'synthetic-bytes-239', hook_event_name: 'SessionStart' }), inspect: tornFiles })
    assert.equal(ran.status, 0, ran.stderr)
    const saved = Object.entries(ran.files).filter(([name]) => name.startsWith('progress.md.torn-'))
    const isCompleteStart = fragment.toString('latin1').split('\n')[0].includes('-->')
    assert.equal(saved.length, isCompleteStart ? 0 : 1)
    if (isCompleteStart) assert.deepEqual(ran.files['progress.md'].subarray(0, file.length), file)
    else assert.deepEqual(saved[0][1], fragment)
    assert.deepEqual(ran.files['progress.md'].subarray(0, Buffer.byteLength(prefix)), Buffer.from(prefix))
  }
})

test('a block without an end marker at the end of the file stays on the board and is not set aside', () => {
  for (const ending of ['', '\n']) {
    const file = `## P\n### Hand\n- [ ] Plan\n<!-- auto session=abcdef12 agent=aider state=working -->\n### Aider task\n- [ ] Keep${ending}`
    const ran = chatRun(['--codex-event'], { file: () => file, input: JSON.stringify({ session_id: 'synthetic-valid-239', hook_event_name: 'SessionStart' }), inspect: tornFiles })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.files['progress.md'].toString('utf8').startsWith(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
    const board = chatRun([], { file: () => ran.files['progress.md'], change: tornChange })
    assert.ok(board.stdout.includes('Aider task') && board.stdout.includes('Hand'), board.stdout)
    assert.ok(!board.stdout.includes('may be hidden'), board.stdout)
  }
})

// A block cut off in the middle of the file: no end marker, and more sections after it.
const cutBoard = (cut = '55fb44cb') => ['# Progress', '', '## demo-152', '', `<!-- auto session=${cut} agent=codex state=waiting updated=2026-10-20T01:17:08.128Z source=turns -->`, '### Add a shelf', '> waiting on your repl', '', '## demo-154', '',
  '<!-- auto session=1d0ef21d agent=codex state=waiting updated=2026-10-20T04:12:58.831Z -->', '### Fix the working text', '- [?] Ship it, OK?', '<!-- /auto session=1d0ef21d -->', '',
  '<!-- auto session=9a9a9a9a agent=codex state=done updated=2026-10-10T04:12:58.831Z -->', '### A finished plan', '- [x] Did it', '<!-- /auto session=9a9a9a9a -->', '', '### Hand-kept task', '- [ ] Keep me', ''].join('\n')
const cutFollowing = cutBoard().slice(cutBoard().indexOf('\n\n## demo-154'))
const cutFiles = dir => ({ board: readFileSync(join(dir, 'progress.md'), 'utf8'), archive: readdirSync(dir).filter(name => name.startsWith('progress-archive-')).map(name => readFileSync(join(dir, name), 'utf8')).join('\n') })

const cutDate = new Date(Date.parse('2026-10-20T01:17:08.128Z'))
const cutDay = `${String(cutDate.getMonth() + 1).padStart(2, '0')}-${String(cutDate.getDate()).padStart(2, '0')}`
// Off a terminal the script draws 80 columns, so the notice wraps onto two rows at a space.
const oneLine = text => text.replace(/\n/g, ' ')

test('the board script places a cut-off block notice at the bottom by agent and date in every language, and leaves it out of --chat', () => {
  for (const [lang, words] of [
    ['en', `A Codex task from ${cutDay} was cut off when its session crashed. It's shown as it was; its last lines may show twice.`],
    ['zh-TW', `${cutDay}的一個 Codex 工作在 session 當掉時被截斷了，照原樣顯示；最後幾行可能會出現兩次。`],
    ['zh-CN', `${cutDay}的一个 Codex 工作在 session 崩溃时被截断了，按原样显示；最后几行可能会出现两次。`],
  ]) {
    const board = chatRun([], { file: () => cutBoard(), lang, change: tornChange })
    assert.equal(board.status, 0, board.stderr)
    assert.equal(oneLine(board.stdout).split(words).length - 1, 1, board.stdout)
    assert.equal(oneLine(board.stdout).trimEnd().endsWith(words), true, board.stdout)
    assert.ok(board.stdout.includes('Fix the working text') && board.stdout.includes('Hand-kept task'), board.stdout)
    const chat = chatRun(['--chat'], { file: () => cutBoard(), lang, change: tornChange })
    assert.equal(chat.status, 0, chat.stderr)
    assert.equal(oneLine(chat.stdout).includes(words), false, chat.stdout)
  }
})

test('the board script names a block cut off at the end of the file once the file has been still for 10 seconds', { timeout: 30_000 }, async () => {
  const endCut = `${cutBoard().slice(0, cutBoard().indexOf('\n\n## demo-154'))}\n`
  const words = `A Codex task from ${cutDay} was cut off when its session crashed. It's shown as it was; its last lines may show twice.`
  const touch = ageMs => questionFault(`const at = (${TORN_NOW} - ${ageMs}) / 1000\nfs.utimesSync(path.join(__dirname, 'progress.md'), at, at)`)
  const settled = chatRun([], { file: () => endCut, change: tornChange, preload: touch(11_000) })
  assert.equal(settled.status, 0, settled.stderr)
  assert.equal(oneLine(settled.stdout).split(words).length - 1, 1, settled.stdout)
  const fresh = chatRun([], { file: () => endCut, change: tornChange, preload: touch(9_000) })
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.equal(oneLine(fresh.stdout).includes(words), false, fresh.stdout)
  const source = `import { readFileSync as fixtureReadClock } from 'node:fs'
Date.now = () => { try { return Number(fixtureReadClock(globalThis.AGENT_BOARD.path + '.clock', 'utf8')) } catch { return ${TORN_NOW} } }
${BOARD_SCRIPT}`
  const served = await page(endCut, {}, [], TORN_NOW, source)
  try {
    const at = (TORN_NOW - 9000) / 1000
    utimesSync(served.path, at, at)
    const ledgerFile = join(served.dir, 'progress-questions.json')
    const poll = async () => assert.equal((await served.call('GET', '/api/board')).status, 200)
    await poll()
    assert.equal(existsSync(ledgerFile), false, 'an unsettled incomplete source must not write a ledger')
    writeFileSync(served.path + '.clock', String(TORN_NOW + 3000))
    await poll()
    assert.equal(existsSync(ledgerFile), true, 'unchanged text must cross the settling boundary before it writes')
    writeFileSync(served.path + '.clock', String(TORN_NOW))
    renameSync(ledgerFile, ledgerFile + '.synthetic-saved')
    await poll()
    assert.equal(existsSync(ledgerFile), false, 'a changed clock must invalidate the settled snapshot and refuse a write')
  } finally {
    await served.close()
  }
})

test('--tidy beside a block cut off in the middle of the file archives the finished block after it alone and keeps the rest', () => {
  const ran = chatRun(['--tidy'], { file: () => cutBoard(), change: tornChange, inspect: cutFiles })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.archive.includes('A finished plan') && !ran.archive.includes('Add a shelf') && !ran.archive.includes('Ship it') && !ran.archive.includes('Keep me'), ran.archive)
  assert.equal(ran.board, cutBoard().replace('<!-- auto session=9a9a9a9a agent=codex state=done updated=2026-10-10T04:12:58.831Z -->\n### A finished plan\n- [x] Did it\n<!-- /auto session=9a9a9a9a -->\n\n', ''))
})

test('a reporter for another session writes below a block cut off in the middle of the file, and one for its own session writes its block in place of the marker line', () => {
  for (const [args, payload] of [
    [['--codex-event'], { session_id: 'synthetic-cut-239', hook_event_name: 'SessionStart' }],
    [['--agent-status', '--agent', 'gemini'], { session_id: 'synthetic-cut-239', state: 'working' }],
    [['--codex-report', '--session', 'synthetic-cut-239'], { project: 'demo-152', title: 'New report', state: 'working', steps: ['- [ ] Next'] }],
  ]) {
    // The marker this reporter gives the session, from a first report on an empty board.
    const first = chatRun(args, { file: () => '# Progress\n', input: JSON.stringify(payload), inspect: cutFiles })
    const marker = /<!-- auto session=([0-9a-f]{8})[^\n]*-->/.exec(first.board)
    assert.ok(marker, `${args[0]}: ${first.board}`)
    const [ownMarker, id] = marker
    const other = chatRun(args, { file: () => cutBoard(), input: JSON.stringify(payload), inspect: cutFiles })
    assert.equal(other.status, 0, other.stderr)
    assert.ok(other.board.startsWith(cutBoard()) && other.board.length > cutBoard().length, `${args[0]}: ${other.board}`)
    // Its own block has no end marker: the reporter writes its closed block in place of the
    // marker line, and the old lines and every section after them stay byte for byte.
    const ownFile = cutBoard().replace(/<!-- auto session=55fb44cb[^\n]*-->/, ownMarker)
    const own = chatRun(args, { file: () => ownFile, input: JSON.stringify(payload), inspect: cutFiles })
    assert.equal(own.status, 0, `${args[0]}: ${own.stderr}`)
    assert.ok(own.board.startsWith(`# Progress\n\n## demo-152\n\n<!-- auto session=${id}`), `${args[0]}: ${own.board}`)
    assert.ok(own.board.endsWith(`<!-- /auto session=${id} -->\n### Add a shelf\n> waiting on your repl${cutFollowing}`), `${args[0]}: ${own.board}`)
  }
})

test('the board script records no question from the half-written last line of a block cut off in the middle', () => {
  const ran = chatRun(['--keys', ''], { file: () => cutBoard().replace('> waiting on your repl', '- [?] Paint it, O'), inspect: dir => ({ ...questionFiles(dir), ...cutFiles(dir) }) })
  assert.equal(ran.status, 0, ran.stderr)
  assert.deepEqual(JSON.parse(ran.files['progress-questions.json']).records.map(row => row.words), ['Ship it, OK?'])
})

test('the board script shows a frozen question once in full without its cut-off prefix', () => {
  const cut = cutBoard().replace('> waiting on your repl', '- [?] Paint it, O')
  const whole = cut.replace('- [?] Paint it, O', '- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->')
  const seeded = chatRun(['--keys', ''], { file: () => whole, change: tornChange, inspect: questionFiles })
  assert.equal(seeded.status, 0, seeded.stderr)
  for (const args of [[], ['--keys', ''], ['--chat']]) {
    const shown = chatRun(args, { file: () => cut, beside: seeded.files, change: tornChange })
    assert.equal(shown.status, 0, shown.stderr)
    assert.equal(shown.stdout.split('Paint it, OK?').length - 1, 1, shown.stdout)
    assert.doesNotMatch(shown.stdout, /Paint it, O(?!K\?)/)
  }
})

test('the board script refuses a hide when the question block loses its end marker during the press', () => {
  const whole = cutBoard().replace('2026-10-20T01:17:08.128Z', new Date(TORN_NOW).toISOString()).replace('> waiting on your repl', '- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->')
  const seeded = chatRun(['--keys', ''], { file: () => whole, change: tornChange, inspect: questionFiles })
  assert.equal(seeded.status, 0, seeded.stderr)
  const paint = JSON.parse(seeded.files['progress-questions.json']).records.find(record => record.words === 'Paint it, OK?')
  const ran = chatRun(['--keys', 'h'], {
    file: () => whole, beside: seeded.files, change: tornChange, inspect: dir => ({ ...questionFiles(dir), ...cutFiles(dir) }),
    preload: questionFault(`Error.stackTraceLimit = 50
const original = fs.readFileSync
const progress = path.join(__dirname, 'progress.md')
const answered = path.join(__dirname, 'progress-answered.json')
let isCut = false
fs.readFileSync = (file, ...rest) => {
  const frames = new Error().stack?.split('\\n') ?? []
  if (!isCut && String(file) === answered && frames.some(line => /^\\s+at act \\(/.test(line)) && frames.some(line => /^\\s+at rewrite \\(/.test(line)) && !frames.some(line => /^\\s+at view \\(/.test(line))) {
    isCut = true
    fs.writeFileSync(progress, original(progress, 'utf8').replace('<!-- /auto session=55fb44cb -->', ''))
  }
  return original(file, ...rest)
}`),
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.board, whole.replace('<!-- /auto session=55fb44cb -->', ''))
  assert.ok(ran.stdout.includes(EN.hideFailed), ran.stdout)
  assert.equal(JSON.parse(ran.answered ?? '{"answered":[]}').answered.includes(paint.id), false)
  const records = JSON.parse(ran.files['progress-questions.json']).records
  assert.deepEqual(records.filter(record => record.words === paint.words).map(record => record.id), [paint.id])
  assert.equal(records.find(record => record.id === paint.id).isUnresolved, true)
})

test('the board script unhides a frozen question without consuming an unmapped legacy acknowledgement', () => {
  const whole = cutBoard().replace('2026-10-20T01:17:08.128Z', new Date(TORN_NOW).toISOString()).replace('> waiting on your repl', '- [?] Paint it, OK?\n<!-- /auto session=55fb44cb -->')
  const seeded = chatRun(['--keys', ''], { file: () => whole, change: tornChange, inspect: questionFiles })
  assert.equal(seeded.status, 0, seeded.stderr)
  const paint = JSON.parse(seeded.files['progress-questions.json']).records.find(record => record.words === 'Paint it, OK?')
  const legacy = '55fb44cb 0 Paint it, OK?'
  const ran = chatRun(['--keys', 'u'], {
    file: () => whole.replace('<!-- /auto session=55fb44cb -->', ''),
    beside: { ...seeded.files, 'progress-answered.json': JSON.stringify({ answered: [paint.id, legacy] }) },
    change: tornChange, inspect: questionFiles,
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.stdout.includes(EN.boardShown), ran.stdout)
  assert.deepEqual(JSON.parse(ran.answered).answered, [legacy])
  const records = JSON.parse(ran.files['progress-questions.json']).records
  assert.deepEqual(records.filter(record => record.words === paint.words).map(record => record.id), [paint.id])
  assert.equal(records.find(record => record.id === paint.id).isUnresolved, true)
})

test('an invalid report leaves the cut marker untouched and creates no saved fragment', () => {
  for (const [args, payload] of [[['--codex-event'], { session_id: 'bad' }], [['--codex-report', '--session', 'synthetic-invalid-239'], { title: '', steps: [] }]]) {
    const file = tornDay()
    const ran = chatRun(args, { file: () => file, input: JSON.stringify(payload), inspect: tornFiles })
    assert.equal(ran.status, 1, ran.stderr)
    assert.deepEqual(ran.files['progress.md'], Buffer.from(file))
    assert.deepEqual(Object.keys(ran.files), ['progress.md'])
  }
})

test('restoring a cut end marker preserves non-ASCII session bytes and report text', () => {
  const file = '## P\n<!-- auto session=工作 agent=aider -->\n### Keep\n- [ ] Next\n<!-- /auto session='
  const ran = chatRun(['--codex-report', '--session', 'synthetic-unicode-239'], { file: () => file, input: JSON.stringify({ project: '專案', title: '進度', state: 'working', steps: ['- [ ] 繼續'] }), inspect: tornFiles })
  assert.equal(ran.status, 0, ran.stderr)
  const saved = ran.files['progress.md'].toString('utf8')
  assert.ok(saved.startsWith(file.slice(0, file.lastIndexOf('<!--')) + '<!-- /auto session=工作 -->\n'), saved)
  assert.ok(saved.includes('## 專案') && saved.includes('### 進度') && saved.includes('- [ ] 繼續'), saved)
})

test('a reporter repairs the cut-off end and adds its report by replacing the board once', () => {
  const ran = chatRun(['--codex-event'], { file: tornDay, input: JSON.stringify({ session_id: 'synthetic-atomic-239', hook_event_name: 'SessionStart' }), inspect: tornFiles, preload: questionFault(`const open = fs.openSync
fs.openSync = (file, flags, ...rest) => { if (String(file).endsWith('progress.md') && flags !== 'r') throw new Error('IN_PLACE_WRITE'); return open(file, flags, ...rest) }
const rename = fs.renameSync
let replacements = 0
fs.renameSync = (from, to) => { if (String(to).endsWith('progress.md') && ++replacements !== 1) throw new Error('SECOND_BOARD_WRITE'); return rename(from, to) }`) })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.files['progress.md'].toString('utf8').includes('source=codex-local'))
  assert.equal(Object.keys(ran.files).filter(name => name.startsWith('progress.md.torn-')).length, 1)
})

test('the bundled release table excludes its current board fingerprint and retains historical ownership', () => {
  const version = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url))).version
  const current = RELEASED.find(release => release.version === version)
  assert.ok(current)
  const ownFingerprint = createHash('sha256').update(BOARD_SCRIPT).digest('hex')
  assert.ok(!BOARD_SCRIPT.includes(ownFingerprint), 'a board cannot embed its own fingerprint')
  for (const fingerprint of current.board.filter(one => one !== ownFingerprint)) {
    assert.ok(BOARD_SCRIPT.includes(fingerprint), 'an earlier tag of the same manifest version remains recognized')
  }
  for (const release of RELEASED.filter(release => release.version !== version)) {
    for (const fingerprint of release.board) assert.ok(BOARD_SCRIPT.includes(fingerprint), 'historical released boards remain recognized')
  }
  for (const kind of ['skill', 'gemini', 'opencode', 'reporterSh', 'reporterPs1']) {
    for (const fingerprint of current[kind]) assert.ok(BOARD_SCRIPT.includes(fingerprint), 'current non-board ownership remains recognized')
  }
})

test('release command normalization keeps platform paths and encoded paths portable', () => {
  for (const sensitive of [false, true]) {
    const normalized = []
    for (const base of ['/home/a', '/home/b', 'C:\\Users\\a', 'C:\\Users\\b']) {
      const sep = base.startsWith('C:') ? '\\' : '/'
      const path = [base, ...(sensitive ? ["$board 'quoted' `ticks` %literal%"] : []), 'agent-board.mjs'].join(sep)
      const command = geminiBoardCommand('Board', 'Show the board.', boardRun(path))
      const canonical = normalizeCommandPath(command, path, '\0board\0')
      assert.ok(canonical.includes('\0board\0'))
      assert.notEqual(normalizeCommandPath(command + '# edited', path, '\0board\0'), canonical)
      normalized.push(canonical)
    }
    assert.ok(normalized.every(text => text === normalized[0]))
  }
})

test('generated board commands pass literal shell-sensitive paths through Gemini and OpenCode wrappers', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-command-'))
  try {
    for (const folder of ['ordinary space', '中文 🧭', "cash $AB_PATH 'quote' \u0060echo probe\u0060 ; & %AB_PATH% ! ( ) { } 中文"]) {
      const directory = join(root, folder)
      mkdirSync(directory)
      const script = join(directory, 'agent-board.mjs')
      writeFileSync(script, "import { readFileSync } from 'node:fs'; process.stdout.write(JSON.stringify({ url: import.meta.url, args: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }))")
      const run = boardRun(script)
      const gemini = geminiBoardCommand('Board: literal paths', 'Show the board.', run)
      const value = /^prompt = (.*)$/m.exec(gemini)?.[1]
      const prompt = JSON.parse(value)
      const geminiRun = /!\{(.*)\}/.exec(prompt)?.[1]
      const opencodeRun = /^!\u0060(.*)\u0060$/m.exec(opencodeBoardCommand('Board: literal paths', 'Show the board.', run))?.[1]
      const isWindows = process.platform === 'win32'
      for (const command of [run + ' --serve', geminiRun, opencodeRun]) {
        assert.ok(command)
        const result = spawnSync(isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', isWindows ? ['/d', '/s', '/c', command] : ['-c', command], {
          env: { ...process.env, AB_PATH: 'expanded-wrong-path' }, input: 'AB-COMMAND-FIXTURE', encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: isWindows, timeout: 10000,
        })
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(JSON.parse(result.stdout), { url: pathToFileURL(script).href, args: ['--serve'], stdin: 'AB-COMMAND-FIXTURE' })
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

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

const run = (lang, args = [], beside = {}, source = FILE, code = BOARD_SCRIPT) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, source)
    for (const [name, text] of Object.entries(beside)) writeFileSync(join(dir, name), text)
    mkdirSync(join(dir, 'progress-inbox'))
    writeFileSync(join(dir, 'progress-inbox', 'gemini-turn-1-1.json'), JSON.stringify({ session_id: 'g1', cwd: join(dir, 'docs-site'), prompt_response: 'Fixed 12 broken links.' }))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${code}`)
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

test('a --serve whose server cannot start says so without mentioning a page', () => {
  const lines = {
    en: "Couldn't open the board page: its server did not start.",
    'zh-TW': '開不了看板網頁：伺服器沒有啟動。',
    'zh-CN': '打不开看板网页：服务器没有启动。',
  }
  for (const [lang, line] of Object.entries(lines)) {
    const text = run(lang, ['--serve', '--no-open', '--port', '65536'])
    assert.equal(text.trim().split('\n').at(-1), line)
    assert.ok(!text.includes('--serve'), 'startup failure gives no instructions for an existing page')
    assert.ok(!text.includes('http://127.0.0.1:'), 'no page address was created')
  }
})

test("the board script does not count a stopped session's question", () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const source of [FILE.replace(WAITING_AT, ENDED_AT), FILE.replace('state=waiting', 'state=ended'), FILE.replace('state=waiting', 'state=done')]) {
    const text = run(lang, ['--all'], {}, source)
    assert.ok(text.startsWith(({ en: 'Progress  ● 0 waiting', 'zh-TW': '進度  ● 0 等你', 'zh-CN': '进度  ● 0 等你' })[lang]), text)
    if (!source.includes('state=done')) {
      assert.ok(text.includes(({ en: '1 stopped', 'zh-TW': '1 項已停止', 'zh-CN': '1 项已停止' })[lang]), text)
    }
    assert.ok(text.includes('Per-key limit'), text)
    const chat = run(lang, ['--chat'], {}, source)
    assert.ok(chat.includes('100 or 300 a minute?'), chat)
  }
})

test("a done session's open question shows on the terminal board", () => {
  const source = FILE.replace('state=waiting', 'state=done')
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const args of [[], ['--all'], ['--chat'], ['--keys', '']]) {
    const text = run(lang, args, {}, source)
    assert.ok(text.includes('Per-key limit'), text)
    assert.ok(text.includes('100 or 300 a minute?'), text)
    assert.ok(!text.includes('a1b2c3d4'), text)
    assert.ok(!text.includes('::'), text)
  }
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

const htmlRun = ({ file = '', inbox = {}, age = 0, lang = 'en', home = dir => dir, beside = {}, now } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-html-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, file)
    for (const [name, text] of Object.entries(beside)) writeFileSync(join(dir, name), text)
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
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${now === undefined ? '' : `Date.now = () => ${now}\n`}${BOARD_SCRIPT.replace('openInBrowser(html,', '((target, done) => done(false))(html,')}`)
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
    ['en', 'Waiting on you', 'codex'],
    ['zh-TW', '等你處理', 'codex'],
    ['zh-CN', '等你处理', 'codex'],
  ]) {
    const page = htmlRun({ inbox: { [HTML_TURN]: htmlTurn(HTML_QUESTION) }, lang })
    assert.ok(page.includes(label) && page.includes(hint), page)
    assert.ok(page.includes('api-gateway') && page.includes('codex'), page)
    assert.equal(page.split(HTML_QUESTION).length - 1, 2)
    assert.ok(page.includes('data-key="section:waiting" open'), page)
    assert.ok(!/Nothing needs you right now|<form|<textarea|fetch\(/.test(page), page)
    // Its only buttons pick the theme or open a section; none sends a reply.
    assert.ok([...page.matchAll(/<button[ >][^>]*>/g)].every(([tag]) => /data-theme-pick=|data-section=/.test(tag)), page)
    assert.ok(/● 1<\/span>/.test(page), page)
  }
})

test('the HTML board keeps a stale inbox question visible until it is processed', () => {
  const page = htmlRun({ inbox: { [HTML_TURN]: htmlTurn(HTML_QUESTION) }, age: 7 * 24 * 60 * 60 * 1000 })
  assert.ok(page.includes(HTML_QUESTION) && page.includes('Waiting on you'), page)
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
  assert.equal(pending.split(HTML_QUESTION).length - 1, 0, page)
  assert.equal(waiting.split(HTML_QUESTION).length - 1, 2, page)
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
const chatRun = (args, { file = () => FILE, beside = {}, lang = 'en', isFolder = false, change = text => text, inbox = {}, inboxTimes = {}, preload = '', inspect = () => ({}), isRelativePath = false, homeName = 'Jane Doe', input = '' } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-chat-'))
  try {
    const home = join(root, homeName)
    const dirs = Object.fromEntries(['.claude', 'AppData', 'Local', 'Roaming', 'config', 'data', 'state', 'cache', 'run'].map(name => [name, join(home, name)]))
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    const path = join(dirs['.claude'], 'progress.md')
    if (!isFolder) writeFileSync(path, file(home))
    else mkdirSync(path)
    for (const [name, text] of Object.entries(beside)) writeFileSync(join(dirs['.claude'], name), text)
    mkdirSync(join(dirs['.claude'], 'progress-inbox'))
    for (const [name, body] of Object.entries(inbox)) {
      const target = join(dirs['.claude'], 'progress-inbox', name)
      writeFileSync(target, body)
      if (inboxTimes[name] !== undefined) utimesSync(target, inboxTimes[name] / 1000, inboxTimes[name] / 1000)
    }
    const script = join(dirs['.claude'], 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: isRelativePath ? join('.claude', 'progress.md') : path, lang })}\n${change(BOARD_SCRIPT)}`)
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home, LOCALAPPDATA: dirs.Local, APPDATA: dirs.Roaming,
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.run,
      TMPDIR: dirs.run, TEMP: dirs.run, TMP: dirs.run,
      CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: '', NO_COLOR: '1',
    }
    const before = readdirSync(dirs['.claude']).sort()
    const unchanged = new Map(before.filter(name => statSync(join(dirs['.claude'], name)).isFile()).map(name => [name, { bytes: readFileSync(join(dirs['.claude'], name)), mtime: statSync(join(dirs['.claude'], name)).mtimeMs }]))
    for (const name of Object.keys(inbox)) {
      const relative = join('progress-inbox', name), source = join(dirs['.claude'], relative)
      unchanged.set(relative, { bytes: readFileSync(source), mtime: statSync(source).mtimeMs })
    }
    const prelude = join(dirs['.claude'], 'fault.cjs')
    if (preload) writeFileSync(prelude, preload)
    const ran = spawnSync(process.execPath, [...(preload ? ['--require', prelude] : []), script, ...args], { env, cwd: isRelativePath ? home : undefined, encoding: 'utf8', timeout: 20000, input })
    const modified = [...unchanged].filter(([name, old]) => !existsSync(join(dirs['.claude'], name)) || !readFileSync(join(dirs['.claude'], name)).equals(old.bytes) || statSync(join(dirs['.claude'], name)).mtimeMs !== old.mtime).map(([name]) => name)
    return { ...ran, home, path, modified, answered: existsSync(join(dirs['.claude'], 'progress-answered.json')) ? readFileSync(join(dirs['.claude'], 'progress-answered.json'), 'utf8') : null, wrote: readdirSync(dirs['.claude']).filter(name => !before.includes(name)), served: readdirSync(dirs.run), ...inspect(dirs['.claude']) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const questionFiles = dir => ({ files: Object.fromEntries(readdirSync(dir).filter(name => name.startsWith('progress-questions')).map(name => [name, readFileSync(join(dir, name), 'utf8')])) })
const questionFault = code => `const fs = require('node:fs')
const cp = require('node:child_process')
const path = require('node:path')
const ledger = path.join(__dirname, 'progress-questions.json')
${code}
require('node:module').syncBuiltinESMExports()
`

test('the terminal board quarantines torn ledgers and rebuilds captured identities so hiding works again', () => {
  const seed = chatRun(['--keys', ''], { inspect: questionFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const original = JSON.parse(seed.files['progress-questions.json'])
  assert.equal(original.records.length, 1)
  assert.ok(Object.keys(seed.files).some(name => name.startsWith('progress-questions-source-')))
  for (const torn of ['{"version":1,"records":[', '{"version":1}\0']) {
    const ran = chatRun(['--keys', 'down h'], {
      beside: { ...seed.files, 'progress-questions.json': torn }, inspect: questionFiles,
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.answered, ran.stdout)
    assert.deepEqual(JSON.parse(ran.answered).answered, [original.records[0].id])
    assert.ok(JSON.parse(ran.files['progress-questions.json']).records.some(row => row.id === original.records[0].id))
    const saved = Object.keys(ran.files).filter(name => /\.torn-\d+-\d+$/.test(name))
    assert.equal(saved.length, 1)
    assert.equal(ran.files[saved[0]], torn)
  }
})

test('the terminal board preserves unknown JSON ledgers and never overwrites a quarantine collision', () => {
  const unknown = '{"version":99,"future":"keep these bytes"}\n'
  const kept = chatRun(['--keys', 'down h'], { beside: { 'progress-questions.json': unknown }, inspect: questionFiles })
  assert.equal(kept.status, 0, kept.stderr)
  assert.deepEqual(kept.files, { 'progress-questions.json': unknown })
  assert.equal(kept.answered, null)
  const torn = '{"version":'
  const collision = chatRun(['--keys', 'down h'], {
    beside: { 'progress-questions.json': torn }, inspect: questionFiles,
    preload: questionFault(`Date.now = () => ${Date.now()}
fs.writeFileSync(ledger + '.torn-' + Date.now() + '-' + process.pid, 'earlier quarantine')`),
  })
  assert.equal(collision.status, 0, collision.stderr)
  assert.equal(collision.files['progress-questions.json'], torn)
  assert.deepEqual(Object.values(collision.files).sort(), ['earlier quarantine', torn].sort())
  assert.equal(collision.answered, null)
})

test('ledger recovery accepts relative progress paths and treats shell-sensitive folders literally', () => {
  const settings = { isRelativePath: true, homeName: "Jane's $Board `literal`", inspect: questionFiles }
  const seed = chatRun(['--keys', ''], settings)
  assert.equal(seed.status, 0, seed.stderr)
  const ran = chatRun(['--keys', 'down h'], { ...settings, beside: { ...seed.files, 'progress-questions.json': '{' } })
  assert.equal(ran.status, 0, ran.stderr)
  assert.deepEqual(JSON.parse(ran.answered).answered, [JSON.parse(seed.files['progress-questions.json']).records[0].id])
  assert.ok(Object.values(ran.files).includes('{'))
})

test('a good ledger raced into quarantine is restored without replacing a newer ledger', () => {
  for (const hasNewer of [false, true]) {
    const good = '{"version":99,"writer":"before move"}\n'
    const newer = '{"version":99,"writer":"after move"}\n'
    const ran = chatRun(['--keys', 'down h'], {
      beside: { 'progress-questions.json': '{' }, inspect: questionFiles,
      preload: questionFault(`const native = cp.spawnSync
let raced = false
cp.spawnSync = (tool, argv, options) => {
  const quarantine = argv.some(arg => String(arg).includes('.torn-'))
  if (!raced && quarantine) {
    raced = true
    fs.writeFileSync(ledger, ${JSON.stringify(good)})
    const result = native(tool, argv, options)
    if (${hasNewer}) fs.writeFileSync(ledger, ${JSON.stringify(newer)})
    return result
  }
  return native(tool, argv, options)
}`),
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.files['progress-questions.json'], hasNewer ? newer : good)
    assert.equal(ran.answered, null)
    const asides = Object.keys(ran.files).filter(name => name.includes('.torn-'))
    assert.equal(asides.length, hasNewer ? 1 : 0)
    if (hasNewer) assert.equal(ran.files[asides[0]], good)
  }
})

test('a first ledger write places the file with a hard link and starts no move program', () => {
  const ran = chatRun(['--keys', ''], {
    inspect: questionFiles,
    preload: questionFault(`const link = fs.linkSync
const move = cp.spawnSync
const probe = { links: 0, moves: [] }
fs.linkSync = (from, to) => {
  if (to === ledger && String(from).endsWith('.board-tmp')) probe.links += 1
  return link(from, to)
}
cp.spawnSync = (tool, argv, options) => {
  if (argv.some(arg => String(arg).includes('.board-tmp'))) probe.moves.push({ tool, argv })
  return move(tool, argv, options)
}
process.on('exit', () => fs.writeFileSync(ledger + '.probe', JSON.stringify(probe)))`),
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(JSON.parse(ran.files['progress-questions.json']).records.length > 0)
  const probe = JSON.parse(ran.files['progress-questions.json.probe'])
  assert.ok(probe.links > 0)
  assert.deepEqual(probe.moves, [])
  assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')))
})

test('a hard-link ledger move leaves both files untouched when another writer placed the ledger first', () => {
  const other = '{"version":99,"writer":"concurrent hard link"}\n'
  const ran = chatRun(['--keys', 'down h'], {
    inspect: questionFiles,
    preload: questionFault(`const link = fs.linkSync
let hasRaced = false
fs.linkSync = (from, to) => {
  if (hasRaced || to !== ledger || !String(from).endsWith('.board-tmp')) return link(from, to)
  hasRaced = true
  const before = fs.readFileSync(from, 'utf8')
  fs.writeFileSync(ledger, ${JSON.stringify(other)})
  try {
    return link(from, to)
  } catch (error) {
    fs.writeFileSync(ledger + '.probe', JSON.stringify({ code: error.code, before, after: fs.readFileSync(from, 'utf8'), target: fs.readFileSync(to, 'utf8') }))
    throw error
  }
}`),
  })
  assert.equal(ran.status, 0, ran.stderr)
  const probe = JSON.parse(ran.files['progress-questions.json.probe'])
  assert.equal(probe.code, 'EEXIST')
  assert.ok(JSON.parse(probe.before).records.length > 0)
  assert.equal(probe.after, probe.before)
  assert.equal(probe.target, other)
  assert.equal(ran.files['progress-questions.json'], other)
  assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')))
  assert.equal(ran.answered, null)
})

test('a ledger move falls back to the move program when the volume has no hard links', () => {
  const ran = chatRun(['--keys', ''], {
    inspect: questionFiles,
    preload: questionFault(`const link = fs.linkSync
const move = cp.spawnSync
const moves = []
fs.linkSync = (from, to) => {
  if (to === ledger && String(from).endsWith('.board-tmp')) throw Object.assign(new Error('no hard links'), { code: 'EPERM' })
  return link(from, to)
}
cp.spawnSync = (tool, argv, options) => {
  if (argv.some(arg => String(arg).includes('.board-tmp'))) moves.push({ tool, argv })
  return move(tool, argv, options)
}
process.on('exit', () => fs.writeFileSync(ledger + '.probe', JSON.stringify(moves)))`),
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(JSON.parse(ran.files['progress-questions.json']).records.length > 0)
  const moves = JSON.parse(ran.files['progress-questions.json.probe'])
  assert.ok(moves.length > 0)
  for (const { tool, argv } of moves) {
    assert.ok(process.platform === 'win32' ? /powershell\.exe$/i.test(tool) : tool === 'mv')
    assert.ok(argv.some(arg => String(arg).includes('.board-tmp')))
    assert.ok(process.platform === 'win32' ? argv.some(arg => String(arg).startsWith('Move-Item -LiteralPath ')) : argv.includes('-n'))
  }
  assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')))
})

test('a ledger move removes its temp after a success, an existing ledger, the fallback and a temp that could not be removed at once', () => {
  const other = '{"version":99,"writer":"concurrent cleanup"}\n'
  const renames = {}
  for (const mode of ['success', 'existing', 'fallback', 'busy']) {
    const ran = chatRun(['--keys', 'down h'], {
      inspect: questionFiles,
      preload: questionFault(`const link = fs.linkSync
const unlink = fs.unlinkSync
const rename = fs.renameSync
const move = cp.spawnSync
const mode = ${JSON.stringify(mode)}
const probe = { links: 0, moves: 0, unlinks: 0, renames: 0, hasBlocked: false }
let temp
fs.renameSync = (from, to) => {
  if (to === ledger) probe.renames += 1
  return rename(from, to)
}
fs.linkSync = (from, to) => {
  if (to !== ledger || !String(from).endsWith('.board-tmp')) return link(from, to)
  probe.links += 1
  temp = from
  if (mode === 'existing') fs.writeFileSync(ledger, ${JSON.stringify(other)})
  if (mode === 'fallback') throw Object.assign(new Error('no hard links'), { code: 'EPERM' })
  return link(from, to)
}
fs.unlinkSync = file => {
  if (file === temp) {
    probe.unlinks += 1
    if (mode === 'busy' && !probe.hasBlocked) {
      probe.hasBlocked = true
      throw Object.assign(new Error('temp held open'), { code: 'EBUSY' })
    }
  }
  return unlink(file)
}
cp.spawnSync = (tool, argv, options) => {
  if (argv.some(arg => String(arg).includes('.board-tmp'))) probe.moves += 1
  return move(tool, argv, options)
}
process.on('exit', () => fs.writeFileSync(ledger + '.probe', JSON.stringify(probe)))`),
    })
    assert.equal(ran.status, 0, mode + ': ' + ran.stderr)
    if (mode === 'existing') {
      assert.equal(ran.files['progress-questions.json'], other)
      assert.equal(ran.answered, null)
    } else assert.ok(JSON.parse(ran.files['progress-questions.json']).records.length > 0, mode)
    const probe = JSON.parse(ran.files['progress-questions.json.probe'])
    assert.ok(probe.links > 0, mode)
    assert.equal(probe.moves > 0, mode === 'fallback', mode)
    assert.equal(probe.hasBlocked, mode === 'busy', mode)
    if (mode === 'busy') assert.ok(probe.unlinks >= 2)
    assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')), mode)
    renames[mode] = probe.renames
  }
  // The retry after a temp that could not be removed finds its own ledger and writes it no second time.
  assert.equal(renames.busy, renames.success)
})

test('a missing ledger install never replaces a concurrent writer or leaves its own skipped temp', () => {
  const other = '{"version":99,"writer":"concurrent"}\n'
  const ran = chatRun(['--keys', 'down h'], {
    inspect: questionFiles,
    preload: questionFault(`const link = fs.linkSync
fs.linkSync = (from, to) => {
  if (String(from).endsWith('.board-tmp')) throw Object.assign(new Error('no hard links'), { code: 'EPERM' })
  return link(from, to)
}
const native = cp.spawnSync
let raced = false
cp.spawnSync = (tool, argv, options) => {
  if (!raced && argv.some(arg => String(arg).includes('.board-tmp'))) {
    raced = true
    fs.writeFileSync(ledger, ${JSON.stringify(other)})
  }
  return native(tool, argv, options)
}`),
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.files['progress-questions.json'], other)
  assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')))
  assert.equal(ran.answered, null)
})

test('a failed ledger replace restores the complete temp or keeps it when every move fails', () => {
  const seed = chatRun(['--keys', ''], { inspect: questionFiles })
  assert.equal(seed.status, 0, seed.stderr)
  for (const [hasLinks, isMoveBlocked] of [[true, false], [false, false], [false, true]]) {
    const ran = chatRun(['--keys', 'down h'], {
      file: () => FILE.replace('Per-key limit', 'Per-account limit'), beside: seed.files, inspect: questionFiles,
      preload: questionFault(`const link = fs.linkSync
fs.linkSync = (from, to) => {
  if (!${hasLinks} && String(from).endsWith('.board-tmp')) throw Object.assign(new Error('no hard links'), { code: 'EPERM' })
  return link(from, to)
}
const native = fs.renameSync
fs.renameSync = (from, to) => {
  if (to !== ledger) return native(from, to)
  fs.unlinkSync(ledger)
  throw Object.assign(new Error('synthetic replace failure'), { code: 'EACCES' })
}
const move = cp.spawnSync
let moves = 0
cp.spawnSync = (tool, argv, options) => {
  if (!argv.some(arg => String(arg).includes('.board-tmp'))) return move(tool, argv, options)
  moves += 1
  return ${isMoveBlocked} ? { status: 1 } : move(tool, argv, options)
}
process.on('exit', () => fs.writeFileSync(ledger + '.probe', String(moves)))`),
    })
    assert.equal(Number(ran.files['progress-questions.json.probe']) > 0, !hasLinks)
    if (isMoveBlocked) {
      assert.equal(ran.status, 1)
      assert.equal(ran.files['progress-questions.json'], undefined)
      const complete = Object.entries(ran.files).filter(([name]) => name.endsWith('.board-tmp'))
      assert.ok(complete.length > 0)
      assert.ok(complete.every(([, text]) => JSON.parse(text).records.some(row => row.words.includes('Per-account'))))
    } else {
      assert.equal(ran.status, 0, ran.stderr)
      assert.ok(JSON.parse(ran.files['progress-questions.json']).records.some(row => row.words.includes('Per-account')))
      assert.ok(!Object.keys(ran.files).some(name => name.endsWith('.board-tmp')))
    }
  }
})

test('--chat remains read-only beside interactive flags even with a torn question ledger', () => {
  for (const torn of ['{', '{"version":1}\0']) {
    const ran = chatRun(['--chat', '--watch', '--serve', '--keys', 'down h'], { beside: { 'progress-questions.json': torn }, inspect: questionFiles })
    assert.equal(ran.status, 0, ran.stderr)
    assert.deepEqual(ran.files, { 'progress-questions.json': torn })
    assert.deepEqual([ran.modified, ran.wrote, ran.served], [[], [], []])
  }
})

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
  assert.ok(unreadable.stdout.includes(EN.fileProgress) && unreadable.stdout.includes(EN.storageIsFolder) && !unreadable.stdout.includes('progress.md'), unreadable.stdout)
  // It only reads: it does not say, as the board does after a write, that files may already have changed.
  assert.ok(unreadable.stdout.includes('nothing was changed') && !/may already have changed/.test(unreadable.stdout), unreadable.stdout)
  assert.ok(!unreadable.stdout.includes(unreadable.home) && !unreadable.stdout.includes('Jane Doe') && !unreadable.stderr.includes('Jane Doe'), unreadable.stdout + unreadable.stderr)
})

test('--chat keeps ordinary key and token budget text readable while hiding synthetic credentials', () => {
  const long = 'abcdef0123456789abcdef0123456789'
  const ran = chatRun(['--chat'], { file: () => `## synthetic
### Per-key limit — key: 100
- [~] daily token: 5
### Private credentials
- [~] key=short-value token: ghp_abc123 password: hunter2 key: ${long} key: hunter3 2FA token: 482913
` })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.stdout.includes('Per-key limit — key: 100') && ran.stdout.includes('daily token: 5'), ran.stdout)
  assert.ok(ran.stdout.includes('key=••• token: ••• password: ••• key: ••• key: ••• 2FA token: •••'), ran.stdout)
  for (const secret of ['short-value', 'ghp_abc123', 'hunter2', long, 'hunter3', '482913']) assert.ok(!ran.stdout.includes(secret), ran.stdout)
  assert.deepEqual([ran.wrote, ran.modified, ran.served], [[], [], []])
})

test('--chat that fails for a reason that is no file says so in one plain line with the home folder hidden, never as a stack trace', () => {
  // The journal call is made to throw an error that names the home folder, as a bug in it might.
  const call = 'doneToday(journalToday('
  assert.ok(BOARD_SCRIPT.includes(call), 'the call this test breaks is no longer in the script')
  const broken = script => script.replace(call, '((...rest) => { throw new TypeError("cannot go on in " + process.env.HOME + "/notes.md") })(journalToday(')
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

test('--chat includes pending progress without claiming an empty board or mutating its sources', () => {
  for (const [lang, heading, empty] of [['en', 'Unprocessed reports', 'No work in progress right now.'], ['zh-TW', '尚未整理的回報', '目前沒有進行中的工作。'], ['zh-CN', '尚未整理的汇报', '目前没有进行中的工作。']]) {
    const ran = chatRun(['--chat', '--serve', '--lang', lang], {
      file: () => '# Progress\n',
      inbox: { 'codex-turn-1792152000-1.json': JSON.stringify({ session_id: 'chat-progress-1', cwd: '/work/export', last_assistant_message: 'Export validation finished; packaging next. token=synthetic-secret' }) },
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.stdout.includes(heading) && ran.stdout.includes('export · codex'), ran.stdout)
    assert.ok(ran.stdout.includes('Export validation finished; packaging next.'), ran.stdout)
    assert.ok(!ran.stdout.includes(empty) && !ran.stdout.includes('synthetic-secret'), ran.stdout)
    assert.ok(!ran.stdout.includes('chat-progress-1') && !ran.stdout.includes('127.0.0.1'), ran.stdout)
    assert.deepEqual([ran.wrote, ran.modified, ran.served], [[], [], []])
    assert.ok(ran.stdout.length <= 3500)
  }
})

test('--chat does not duplicate a claimed digest or mistake a fresh heartbeat for processing', () => {
  const source = Date.parse('2026-10-16T12:00:00Z')
  const body = JSON.stringify({ session_id: 'chat-progress-1', cwd: '/work/export', last_assistant_message: 'Validation finished; package next.' })
  for (const isClaimed of [true, false]) {
    const original = `codex-turn-${source}-1.json`
    const name = isClaimed ? `${original}.digestowner-${(source + 500).toString(36)}-1.taking` : original
    const ran = chatRun(['--chat'], {
      file: () => `## export\n<!-- auto session=12345678 agent=codex resume=chat-progress-1 state=working updated=${new Date(source + 1000).toISOString()} -->\n### Export package\n- [~] Package next\n<!-- /auto session=12345678 -->\n`,
      inbox: { [name]: body },
      change: script => `Date.now = () => ${source + 2000}\n${script}`,
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout.includes('Validation finished; package next.'), !isClaimed, ran.stdout)
    assert.equal(ran.stdout.includes('Unprocessed reports'), !isClaimed, ran.stdout)
    assert.equal(ran.stdout.split('› Export package').length - 1, 1, ran.stdout)
    assert.deepEqual([ran.wrote, ran.modified, ran.served], [[], [], []])
  }
})

for (const kind of ['future', 'unsafe-order', 'unknown-source', 'unbound-session']) test(`--chat keeps unprocessed reports and questions after ${kind} prompt metadata`, () => {
  const now = Date.now(), source = now - 2000
  const report = kind === 'unknown-source' ? 'codex-turn-no-clock-1.json' : `codex-turn-${source}-1.json`
  const promptAt = kind === 'future' ? now + 86400000 : kind === 'unsafe-order' ? Number.MAX_SAFE_INTEGER : now
  const prompt = `codex-prompt-${promptAt}-2.json`
  for (const answer of ['Validation finished; packaging next.', 'Ship it to staging now?']) {
    const ran = chatRun(['--chat'], {
      file: () => '# Progress\n',
      inbox: {
        [report]: JSON.stringify({ session_id: 'pending-preview', cwd: '/work/export', last_assistant_message: answer }),
        [prompt]: JSON.stringify({ session_id: 'pending-preview', prompt: 'PRIVATE_NEW_INPUT', last_assistant_message: 'PRIVATE_FAKE_REPLY?', transcript_path: '/synthetic/not-read.jsonl' }),
      },
      inboxTimes: { [report]: now - 100, [prompt]: now },
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.stdout.includes(answer), ran.stdout)
    assert.ok(!ran.stdout.includes('No work in progress right now.'), ran.stdout)
    assert.ok(!ran.stdout.includes('PRIVATE_') && !ran.stdout.includes('not-read'), ran.stdout)
    assert.deepEqual([ran.wrote, ran.modified, ran.served], [[], [], []])
  }
})

test('--chat shows pending metadata without forwarding a raw user prompt', () => {
  const ran = chatRun(['--chat'], {
    file: () => '# Progress\n',
    inbox: { 'codex-turn-1792152000-1.json': JSON.stringify({ session_id: 'chat-progress-1', cwd: '/work/export', prompt: 'Private original request' }) },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(ran.stdout.includes('export · codex') && ran.stdout.includes('No progress summary yet'), ran.stdout)
  assert.ok(!ran.stdout.includes('Private original request'), ran.stdout)
  assert.deepEqual([ran.wrote, ran.modified, ran.served], [[], [], []])
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
for (const isSettled of [false, true]) test(isSettled ? 'a press failure redraws the board after the question snapshot settles' : 'a press on the board names an answered list it cannot read or replace, with its error, and never writes over it', () => {
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
    const events = join(dir, 'fault-events.txt')
    let clock = Date.now()
    const play = fault => {
      clock += 10000
      writeFileSync(events, '')
      writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
let now = ${clock}
Date.now = () => now
const clockRead = fs.readFileSync
fs.readFileSync = (file, ...rest) => {
  const value = clockRead(file, ...rest)
  if (String(file) === ${JSON.stringify(list)}) now = ${clock} + ${isSettled ? 2000 : 0}
  return value
}
const inPress = () => new Error().stack?.split('\\n').some(line => /^\\s+at act \\(/.test(line))
const record = code => fs.appendFileSync(${JSON.stringify(events)}, code + '\\n')
${fault}
syncBuiltinESMExports()`)
      return spawnSync(process.execPath, ['-r', preload, script, '--keys', 'h'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
    }
    // A settled view can migrate this list before the press. Scope the fault to
    // the action's stack instead of a read count, and exercise both clock phases.
    const faults = [
      [`const original = fs.readFileSync\nlet isFailed = false\nfs.readFileSync = (file, ...rest) => { if (!isFailed && String(file) === ${JSON.stringify(list)} && inPress()) { isFailed = true; record('EACCES'); throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }) } return original(file, ...rest) }`, 'EACCES'],
      [`const original = fs.renameSync\nfs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(list)} && inPress()) { record('EIO'); throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }) } return original(from, to) }`, 'EIO'],
    ]
    for (const [fault, code] of faults) {
      const out = play(fault)
      const said = out.stdout + out.stderr
      assert.equal(out.status, 1, said)
      assert.ok(said.includes('progress-answered.json') && said.includes(code === 'EACCES' ? EN.storageReadOnly : EN.storageUnknown) && !said.includes(list), said)
      assert.ok(!said.includes('Hidden:'), said)
      // The board is drawn after the press, with the question still on it.
      assert.ok(out.stdout.includes('Per-key limit'), said)
      const injected = readFileSync(events, 'utf8').trim().split('\n')
      assert.ok(injected.length > 0 && injected.every(event => event === code), said)
      assert.equal(readFileSync(list, 'utf8'), held)
      assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
    }
    // Once it can be read and replaced, the same press hides the question and keeps the old mark.
    const out = play('')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.equal(readFileSync(events, 'utf8'), '')
    const answered = JSON.parse(readFileSync(list, 'utf8')).answered
    assert.deepEqual([answered.length, answered[0], /^question:[a-f0-9]{64}:\d+$/.test(answered[1])], [2, 'c0ffee12 1 Ship it, OK?', true])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI ticks rotate a full journal, chat reads the last part, and archive retries find earlier entries', () => {
  const at = Date.UTC(2026, 9, 17, 12)
  const month = `${new Date(at).getFullYear()}-${String(new Date(at).getMonth() + 1).padStart(2, '0')}`
  const journal = `progress-journal-${month}.md`
  const nextJournal = `progress-journal-${month}-2.md`
  const archive = `progress-archive-${month}.md`
  const file = '## Synthetic\n### Synthetic work\n- [ ] Verify rotation\n'
  const inspect = dir => ({ files: Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.md')).map(name => [name, readFileSync(join(dir, name), 'utf8')])) })
  const change = script => `Date.now = () => ${at}\n${script}`
  const full = 'x'.repeat(1048576)
  const ticked = chatRun(['--keys', 'x'], { file: () => file, beside: { [journal]: full }, change, inspect })
  assert.equal(ticked.status, 0, ticked.stdout + ticked.stderr)
  assert.equal(ticked.files[journal], full)
  assert.ok(ticked.files['progress.md'].includes('- [x] Verify rotation'))
  assert.ok(ticked.files[nextJournal].includes('Synthetic · Synthetic work · Verify rotation'))
  const chat = chatRun(['--chat'], { file: () => ticked.files['progress.md'], beside: { [journal]: full, [nextJournal]: ticked.files[nextJournal] }, change })
  assert.equal(chat.status, 0, chat.stdout + chat.stderr)
  assert.match(chat.stdout, /✓ 1 done today/)
  assert.ok(chat.stdout.includes('Synthetic work: Verify rotation'), chat.stdout)
  const saved = chatRun(['--keys', 'a'], { file: () => file, change, inspect })
  assert.equal(saved.status, 0, saved.stdout + saved.stderr)
  const entry = saved.files[archive]
  assert.ok(entry.includes('### Synthetic work'))
  // Padding precedes the saved entry so its task still ends at the end of the file.
  const earlier = `${'x'.repeat(1048576 - Buffer.byteLength(entry) - 1)}\n${entry}`
  assert.equal(Buffer.byteLength(earlier), 1048576)
  const retried = chatRun(['--keys', 'a'], { file: () => file, beside: { [archive]: earlier }, change, inspect })
  assert.equal(retried.status, 0, retried.stdout + retried.stderr)
  assert.equal(retried.files[archive], earlier)
  assert.ok(!retried.files['progress.md'].includes('### Synthetic work'))
  assert.ok(!retried.files[`progress-archive-${month}-2.md`]?.includes('### Synthetic work'))
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
    const archived = play('i down a')
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
    const archived = play('i down down a')
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
const watchPress = (initial, replacement, keys, args = []) => {
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
    const out = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--watch', ...args], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000 })
    return { out, after: readFileSync(path, 'utf8'), dir }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const LINE_CHANGED = 'That line just changed; check the one chosen now and press again.'

test('terminal Confirm done finishes every open step and refuses changes below the next step', () => {
  const file = '## Synthetic\n### Finish the task\n- [ ] First\n- [~] Later\n- [>] Running\n- [!] Blocked\n- [-] Canceled\n- [x] Already done\n'
  const done = watchPress(file, file, ['d'])
  assert.match(done.out, /Confirmed “Finish the task” done\./)
  assert.equal(done.after, file.replace(/\[(?: |~|>|!)\]/g, '[x]'))
  const changed = file.replace('Later', 'Changed later step')
  const refused = watchPress(file, changed, ['d'])
  assert.match(refused.out, /That line just changed/)
  assert.equal(refused.after, changed)
})

test('the terminal board archives with a only the block it drew: another session’s block under the same title is left alone and named as changed', { timeout: 30_000 }, () => {
  const updated = ago(20 * 60 * 60 * 1000)
  const initial = `# Progress\n\n## synthetic\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=${updated} -->\n### Synthetic same-title task\n- [ ] Keep this task\n<!-- /auto session=a1b2c3d4 -->\n`
  const replacement = initial.replaceAll('a1b2c3d4', 'd4e5f6a7')
  const refused = watchPress(initial, replacement, ['a'], ['--all'])
  assert.equal(refused.after, replacement)
  assert.ok(refused.out.includes(LINE_CHANGED), refused.out)
  assert.ok(!refused.out.includes('Archived'), refused.out)
  // The block that was drawn, still there, goes to the archive as before.
  const archived = watchPress(initial, initial, ['a'], ['--all'])
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
const servedAt = (run, path) => join(process.platform === 'win32' ? join(run, 'agent-board') : run, `agent-board-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`)

// These fixtures stand for an address written by an older, trusted server. A broad legacy
// file has its own refusal test and must not be made trusted merely by moving it.
const addressFixture = (file, text) => {
  writeFileSync(file, text)
  if (process.platform !== 'win32') return
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // /grant:r retains unrelated explicit grants. A trusted synthetic legacy file needs a
  // fresh DACL, including on a CI account whose default file grants are explicit.
  execFileSync(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $PSModuleAutoLoadingPreference = 'None'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
      + '$security = [System.Security.AccessControl.FileSecurity]::new(); $security.SetOwner($sid); $security.SetAccessRuleProtection($true, $false); '
      + '$security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)); '
      + '[System.IO.File]::SetAccessControl($env:AGENT_BOARD_ACL_FIXTURE_PATH, $security)',
  ], { env: { ...process.env, AGENT_BOARD_ACL_FIXTURE_PATH: file }, windowsHide: true, stdio: 'pipe' })
}

const windowsAcl = (file, env) => {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  return JSON.parse(execFileSync(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    '$acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:AGENT_BOARD_ACL_TEST_PATH; '
      + '[pscustomobject]@{ AreAccessRulesProtected = $acl.AreAccessRulesProtected; Sddl = $acl.Sddl; OwnerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Sids = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) } | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress',
  ], {
    env: { ...env, PSModulePath: join(system, 'WindowsPowerShell', 'v1.0', 'Modules'), AGENT_BOARD_ACL_TEST_PATH: file }, encoding: 'utf8', windowsHide: true,
  }))
}

// A live session's question: a stopped session's question no longer waits on you (#185),
// so page tests that need a waiting question add this one.
const LIVE_QUESTION = `\n## billing\n<!-- auto session=d4e5f6a7 agent=grok state=waiting updated=RECENT -->\n### Pick invoice format\n- [x] Read\n- [?] PDF or HTML?\n<!-- /auto session=d4e5f6a7 -->\n`

const page = async (more = '', env = {}, serveArgs = [], now, source = BOARD_SCRIPT) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const work = join(dir, 'api-gateway')
  mkdirSync(work)
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const path = join(dir, 'progress.md')
  const recent = new Date((now ?? Date.now()) - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
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
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${now === undefined ? '' : `Date.now = () => ${now}\n`}${source}`)
  const child = spawn(process.execPath, [script, '--serve-child', ...serveArgs], {
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand, XDG_RUNTIME_DIR: run, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
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
      req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP request timed out')))
      req.on('error', fail)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const rows = async () => {
    const model = (await call('GET', '/api/board')).json().model
    return [...model.groups.flatMap(group => group.rows), ...model.stopped]
  }
  const rowOf = async title => (await rows()).find(row => row.title === title)
  const keyOf = async title => (await rowOf(title))?.key
  const close = async () => {
    if (child.exitCode === null) await call('POST', '/api/close', { body: {} }).catch(() => undefined)
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))])
    if (code === 'still running') {
      child.kill()
      if (await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 5000))]) === 'still running') throw new Error('Fixture process did not exit')
    }
    // The synchronous API does not retry a Windows process's lingering cwd handle.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return code
  }
  return { dir, path, url, port, token, call, rows, rowOf, keyOf, close, exited, stderr: () => stderr, served: servedAt(run, path) }
}

test('live blocks of every agent refuse forged web archives without writes and terminal a and tidy preserve them', { timeout: 30_000 }, async () => {
  const agents = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'hermes', 'openclaw', 'opencode', 'antigravity', 'deepseek', 'custom-agent']
  const blocks = agents.flatMap((agent, index) => ['working', 'waiting'].map((state, n) => {
    const id = String(10000000 + index * 2 + n)
    return `<!-- auto session=${id} agent=${agent} state=${state} updated=${ago(60000)} -->\n### Synthetic ${agent} ${state}\n- [ ] Next step\n<!-- /auto session=${id} -->\n`
  })).join('\n')
  const board = await page()
  try {
    const file = `# Progress\n\n## Synthetic\n${blocks}`
    writeFileSync(board.path, file)
    const files = readdirSync(board.dir).sort()
    const model = (await board.call('GET', '/api/board')).json().model
    const rows = [...model.groups.flatMap(group => group.rows), ...model.stopped]
    assert.equal(rows.length, 24)
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const dom = await pageDom(html, model)
    assert.ok(!dom.node('board').textContent.includes('Archive'), dom.node('board').textContent)
    assert.ok(dom.node('board').textContent.includes('Still running; archive after it stops.'))
    for (const row of rows) {
      assert.equal(row.canArchive, false)
      const reply = await board.call('POST', '/api/act', { body: { key: row.key, type: 'archive', text: '', session: '', fp: row.fp } })
      assert.equal(reply.status, 409, reply.body)
      assert.match(reply.json().note, /Still running/)
      assert.equal(readFileSync(board.path, 'utf8'), file)
      assert.deepEqual(readdirSync(board.dir).sort(), files)
    }
    const terminal = execFileSync(process.execPath, [join(board.dir, 'agent-board.mjs'), '--keys', Array.from({ length: 24 }, () => 'a down').join(' ')], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 5000 })
    assert.match(terminal, /Still running; archive after it stops\./)
    assert.equal(readFileSync(board.path, 'utf8'), file)
    assert.deepEqual(readdirSync(board.dir).sort(), files)
    assert.equal((await board.call('POST', '/api/tidy', { body: {} })).status, 200)
    assert.equal(readFileSync(board.path, 'utf8'), file)
    assert.deepEqual(readdirSync(board.dir).sort(), files)
  } finally { await board.close() }
})

test('page Confirm done buttons act once with exact fingerprints and journal all new ticks in three languages', { timeout: 30_000 }, async () => {
  const labels = { en: 'Confirm done', 'zh-TW': '確認完成', 'zh-CN': '确认完成' }
  for (const lang of Object.keys(labels)) {
    const board = await page('', {}, ['--lang', lang])
    try {
      const steps = '- [ ] Todo\n- [~] Doing\n- [?] Ask?\n- [>] Running\n- [!] Blocked\n- [-] Canceled\n- [x] Already done\n'
      const file = `## Synthetic\n### Manual\n${steps}\n<!-- auto session=11223344 agent=claude state=ended updated=${ago(3600000)} -->\n### Ended Claude\n${steps}<!-- /auto session=11223344 -->\n<!-- auto session=22334455 agent=codex state=waiting updated=${ago(13 * 3600000)} -->\n### Stopped Codex\n${steps}<!-- /auto session=22334455 -->\n<!-- auto session=33445566 agent=codex state=working updated=${ago(60000)} -->\n### Live task\n- [ ] Leave open\n<!-- /auto session=33445566 -->\n`
      writeFileSync(board.path, file)
      const model = (await board.call('GET', '/api/board')).json().model
      const rows = [...model.stopped, ...model.groups.flatMap(group => group.rows)]
      assert.equal(rows.filter(row => row.canConfirm).length, 3)
      const html = (await board.call('GET', `/?t=${board.token}`)).body
      const dom = await pageDom(html, model, { post: async request => {
        const response = await board.call('POST', request.path, { body: request.body })
        assert.equal(response.status, 200, response.body)
        return { ok: true, json: async () => response.json() }
      } })
      const buttons = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...buttons(child)])
      const confirms = buttons(dom.node('board')).filter(button => button.textContent === labels[lang])
      assert.equal(confirms.length, 3)
      confirms[rows.filter(row => row.canConfirm).findIndex(row => row.title === 'Manual')].click()
      await dom.flush()
      const live = rows.find(row => row.title === 'Live task')
      assert.equal((await board.call('POST', '/api/act', { body: { key: live.key, type: 'done', fp: live.fp } })).status, 409)
      for (const row of rows.filter(row => row.canConfirm && row.title !== 'Manual')) {
        const response = await board.call('POST', '/api/act', { body: { key: row.key, type: 'done', fp: row.fp } })
        assert.equal(response.status, 200, response.body)
      }
      const after = readFileSync(board.path, 'utf8')
      assert.equal((after.match(/state=done updated=/g) ?? []).length, 2)
      assert.equal((after.match(/- \[-\] Canceled/g) ?? []).length, 3)
      assert.ok(after.includes('- [ ] Leave open'))
      const journal = readdirSync(board.dir).find(name => name.includes('-journal-'))
      const history = readFileSync(join(board.dir, journal), 'utf8')
      assert.equal(history.split('\n').filter(line => line.startsWith('- ')).length, 15)
      assert.ok(!history.includes('Canceled') && !history.includes('Already done'))
      const repeat = await board.call('POST', '/api/act', { body: { key: rows.find(row => row.title === 'Manual').key, type: 'done', fp: rows.find(row => row.title === 'Manual').fp } })
      assert.equal(repeat.status, 409)
      assert.equal(readFileSync(join(board.dir, journal), 'utf8'), history)
      writeFileSync(board.path, file)
      const changed = file.replace('Doing', 'Changed later step')
      writeFileSync(board.path, changed)
      const row = rows.find(row => row.title === 'Manual')
      assert.equal((await board.call('POST', '/api/act', { body: { key: row.key, type: 'done', fp: row.fp } })).status, 409)
      assert.equal(readFileSync(board.path, 'utf8'), changed)
    } finally { await board.close() }
  }
})

test('unseen inbox questions survive same-batch end and restart after a stale mutable ledger overwrite', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const inbox = join(board.dir, 'progress-inbox')
    mkdirSync(inbox)
    const texts = ['Keep option A?', 'Keep option B?', 'Keep the end-only original?']
    const names = ['codex-turn-1792152000-1.json', 'codex-turn-1792152000-2.json', 'codex-end-1792152000-3.json']
    names.forEach((name, index) => writeFileSync(join(inbox, name), JSON.stringify({ session_id: 'one-owner', cwd: '/work/api-gateway', last_assistant_message: texts[index] })))
    const model = async () => (await board.call('GET', '/api/board')).json().model
    const asks = (await model()).asks.filter(one => one.agent === 'codex')
    assert.deepEqual(asks.map(one => one.text).sort(), [...texts].sort())
    const file = join(board.dir, 'progress-questions.json')
    const records = JSON.parse(readFileSync(file, 'utf8')).records.filter(one => texts.includes(one.words))
    assert.equal(records.length, 3)
    const captures = readdirSync(board.dir).filter(name => /^progress-questions-source-[a-f0-9]{64}\.json$/.test(name))
    for (const text of texts) assert.ok(captures.some(name => JSON.parse(readFileSync(join(board.dir, name), 'utf8')).record.source.text === text))
    for (const name of names) rmSync(join(inbox, name))
    writeFileSync(file, JSON.stringify({ version: 1, next: 1, records: [], legacy: {} }))
    assert.deepEqual((await model()).asks.filter(one => one.agent === 'codex').map(one => one.text).sort(), [...texts].sort())
    const restarted = execFileSync(process.execPath, [join(board.dir, 'agent-board.mjs'), '--chat'], { env: { ...process.env, CLAUDE_PROGRESS_FILE: board.path, NO_COLOR: '1' }, encoding: 'utf8' })
    for (const text of texts) assert.ok(restarted.includes(text), restarted)
    const recovered = JSON.parse(readFileSync(file, 'utf8')).records
    for (const record of records) assert.equal(recovered.find(one => one.id === record.id)?.firstObserved, record.firstObserved)
  } finally {
    await board.close()
  }
})

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
    const served = (await board.call('GET', '/api/board')).json().model.asks.filter(one => one.agent === 'codex')
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
    const question = () => JSON.parse(readFileSync(join(dir, 'progress-questions.json'), 'utf8')).records.find(row => row.words === 'PDF or HTML?' && row.isWaiting).id
    const model = async () => (await call('GET', '/api/board')).json().model
    const ask = (await model()).asks.find(one => one.agent === 'codex')
    assert.equal(ask.canHide, true)
    assert.deepEqual(ask.answers, ['PDF', 'HTML'])
    const hid = await call('POST', '/api/act', { body: { key: ask.key, type: 'hide' } })
    assert.equal(hid.status, 200, hid.body)
    assert.equal(hid.json().note, 'Hidden: “PDF or HTML?”; it comes back when the question changes.')
    assert.deepEqual(hidden(), [question()])
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
    assert.deepEqual(hidden(), [question()])
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
    assert.deepEqual(hidden(), [question()])
    // Nothing went to any agent, and every block is as its session wrote it.
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.ok(!existsSync(join(dir, 'grok-ran.json')))
  } finally {
    await board.close()
  }
})

test('the serve page repairs a torn ledger and hides its captured question without changing the report', { timeout: 30_000 }, async () => {
  // A live session's question: a stopped session's question no longer waits on you (#185).
  const board = await page(`\n## billing\n<!-- auto session=d4e5f6a7 agent=codex state=waiting updated=RECENT -->\n### Pick invoice format\n- [x] Read\n- [?] PDF or HTML?\n<!-- /auto session=d4e5f6a7 -->\n`)
  try {
    const report = readFileSync(board.path, 'utf8')
    const model = async () => (await board.call('GET', '/api/board')).json().model
    const asks = (await model()).asks
    assert.equal(asks.length, 1)
    const before = asks[0]
    const ledger = join(board.dir, 'progress-questions.json')
    const identity = JSON.parse(readFileSync(ledger, 'utf8')).records.find(row => row.words === 'PDF or HTML?' && row.isWaiting).id
    writeFileSync(ledger, '{"version":1,')
    const restored = (await model()).asks.find(row => row.text === before.text)
    assert.ok(restored?.canHide)
    const hid = await board.call('POST', '/api/act', { body: { key: restored.key, type: 'hide' } })
    assert.equal(hid.status, 200, hid.body)
    assert.deepEqual(JSON.parse(readFileSync(join(board.dir, 'progress-answered.json'), 'utf8')).answered, [identity])
    assert.equal((await model()).asks.length, 0)
    assert.equal(readFileSync(board.path, 'utf8'), report)
    const saved = readdirSync(board.dir).filter(name => name.startsWith('progress-questions.json.torn-'))
    assert.equal(saved.length, 1)
    assert.equal(readFileSync(join(board.dir, saved[0]), 'utf8'), '{"version":1,')
  } finally {
    await board.close()
  }
})

test('served questions keep hidden identities across reordered reports and a fresh board process in every language', { timeout: 30_000 }, async () => {
  let board = await page(`\n## billing\n<!-- auto session=d4e5f6a7 agent=codex state=waiting updated=RECENT -->\n### Pick invoice format\n- [x] Read\n- [?] PDF or HTML?\n<!-- /auto session=d4e5f6a7 -->\n`)
  try {
    const model = async () => (await board.call('GET', '/api/board')).json().model
    const ask = (await model()).asks.find(one => one.agent === 'codex')
    assert.equal((await board.call('POST', '/api/act', { body: { key: ask.key, type: 'hide' } })).status, 200)
    const original = readFileSync(board.path, 'utf8')
    const changed = original.replace('- [x] Read\n- [?] PDF or HTML?', '- [?] PDF  or\tHTML?\n- [x] Inserted\n- [x] Read')
    writeFileSync(board.path, changed)
    const moved = await model()
    assert.equal(moved.asks.some(one => one.agent === 'codex'), false)
    assert.equal(moved.hidden.find(one => one.agent === 'codex')?.text, 'PDF  or\tHTML?')
    const saved = Object.fromEntries(['progress-answered.json', 'progress-questions.json'].map(name => [name, readFileSync(join(board.dir, name), 'utf8')]))
    await board.close()
    board = await page()
    writeFileSync(board.path, changed)
    for (const [name, text] of Object.entries(saved)) writeFileSync(join(board.dir, name), text)
    assert.equal((await model()).asks.some(one => one.agent === 'codex'), false)
    const script = join(board.dir, 'read-only-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: board.path, lang: 'en' })}\n${BOARD_SCRIPT.replace('openInBrowser(html,', '((target, done) => done(false))(html,')}`)
    for (const lang of ['en', 'zh-TW', 'zh-CN']) {
      const run = flag => execFileSync(process.execPath, [script, flag, '--lang', lang], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROGRESS_FILE: board.path, NO_COLOR: '1' } })
      const chat = run('--chat')
      assert.ok(!chat.includes('PDF  or') && !chat.includes('PDF or HTML?'), chat)
      run('--html')
      const html = readFileSync(join(board.dir, 'progress.html'), 'utf8')
      const waiting = html.match(/data-key="section:waiting"[\s\S]*?<\/details>/)?.[0] ?? ''
      assert.ok(!waiting.includes('PDF or HTML?') && !waiting.includes('PDF  or'), html)
      assert.ok(html.includes('PDF  or') || html.includes('PDF or HTML?'), html)
      assert.match(html, /● 0<\/span>/)
      assert.equal(readFileSync(join(board.dir, 'progress-answered.json'), 'utf8'), saved['progress-answered.json'])
      assert.equal(readFileSync(join(board.dir, 'progress-questions.json'), 'utf8'), saved['progress-questions.json'])
    }
    const restored = await model()
    const hidden = restored.hidden.find(one => one.agent === 'codex')
    assert.equal((await board.call('POST', '/api/act', { body: { key: hidden.key, type: 'unhide' } })).status, 200)
    assert.equal((await model()).asks.some(one => one.agent === 'codex'), true)
  } finally {
    await board.close()
  }
})

test('the terminal board and the page retire a resolution once the agent ticks its step', { timeout: 30_000 }, async () => {
  for (const surface of ['terminal', 'page']) {
    const dir = surface === 'terminal' ? mkdtempSync(join(tmpdir(), 'board-resolve-')) : null
    const board = dir === null ? await page() : { dir, path: join(dir, 'progress.md'), close: async () => rmSync(dir, { recursive: true, force: true }) }
    try {
      const script = join(board.dir, 'agent-board.mjs')
      if (surface === 'terminal') writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: board.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
      const observe = async () => surface === 'terminal'
        ? execFileSync(process.execPath, [script, '--keys', ''], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8' })
        : (await board.call('GET', '/api/board')).json().model
      writeFileSync(board.path, FILE)
      await observe()
      const file = join(board.dir, 'progress-questions.json')
      const ledger = JSON.parse(readFileSync(file, 'utf8'))
      const original = ledger.records.find(record => record.words === 'Per-key limit — 100 or 300 a minute?')
      assert.ok(original, surface)
      const resolved = { ...original, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: Date.now() }
      const capture = JSON.stringify({ version: 1, disposition: 'resolved', record: resolved }) + '\n'
      const hash = createHash('sha256').update(capture).digest('hex')
      writeFileSync(join(board.dir, `progress-questions-source-${hash}.json`), capture)
      const retired = join(board.dir, `progress-questions-retired-${createHash('sha256').update(original.id).digest('hex')}.json`)
      for (let poll = 0; poll < 2; poll += 1) {
        await observe()
        assert.equal(existsSync(retired), false, `${surface}: Resolve lasts while the question remains`)
      }
      const saved = readFileSync(file, 'utf8')
      writeFileSync(board.path, FILE.replace('- [?]', '- [x]'))
      await observe()
      assert.equal(existsSync(retired), true, `${surface}: completing the step retires its resolution`)
      writeFileSync(file, saved)
      writeFileSync(board.path, FILE)
      const shown = await observe()
      const renewed = JSON.parse(readFileSync(file, 'utf8')).records.find(record => record.words === original.words && record.isUnresolved && record.isWaiting)
      assert.ok(renewed, `${surface}: stale ledger replay cannot hide the renewed question`)
      assert.notEqual(renewed.id, original.id)
      if (surface === 'terminal') assert.ok(shown.includes('1 waiting'), shown)
      else assert.ok(shown.asks.some(ask => ask.text === 'Per-key limit'))
    } finally {
      await board.close()
    }
  }
})

test('a restarted served board applies immutable retirement evidence after stale active ledger replay', { timeout: 30_000 }, async () => {
  let board = await page(`\n## billing\n<!-- auto session=d4e5f6a7 agent=codex state=waiting updated=RECENT -->\n### Ship invoice\n- [?] Publish invoice?\n<!-- /auto session=d4e5f6a7 -->\n`)
  try {
    const model = async () => (await board.call('GET', '/api/board')).json().model
    const first = (await model()).asks.find(one => one.agent === 'codex')
    assert.equal((await board.call('POST', '/api/act', { body: { key: first.key, type: 'hide' } })).status, 200)
    const oldLedger = readFileSync(join(board.dir, 'progress-questions.json'), 'utf8')
    const oldHide = readFileSync(join(board.dir, 'progress-answered.json'), 'utf8')
    const waiting = readFileSync(board.path, 'utf8')
    writeFileSync(board.path, waiting.replace('- [?] Publish invoice?', '- [x] Publish invoice?'))
    await model()
    writeFileSync(board.path, waiting)
    const renewed = (await model()).asks.find(one => one.agent === 'codex')
    assert.ok(renewed)
    assert.equal((await board.call('POST', '/api/act', { body: { key: renewed.key, type: 'hide' } })).status, 200)
    const proofs = Object.fromEntries(readdirSync(board.dir).filter(name => /^progress-questions-retired-/.test(name)).map(name => [name, readFileSync(join(board.dir, name), 'utf8')]))
    assert.ok(Object.keys(proofs).length > 0)
    await board.close()
    board = await page()
    writeFileSync(board.path, waiting)
    writeFileSync(join(board.dir, 'progress-questions.json'), oldLedger)
    writeFileSync(join(board.dir, 'progress-answered.json'), oldHide)
    for (const [name, text] of Object.entries(proofs)) writeFileSync(join(board.dir, name), text)
    assert.equal((await model()).asks.some(one => one.agent === 'codex'), true)
    const proof = Object.keys(proofs)[0]
    writeFileSync(join(board.dir, proof), '{')
    const visible = (await model()).asks.find(one => one.agent === 'codex')
    assert.ok(visible)
    const refused = await board.call('POST', '/api/act', { body: { key: visible.key, type: 'hide' } })
    assert.equal(refused.status, 409)
    assert.equal(readFileSync(join(board.dir, proof), 'utf8'), '{')
  } finally {
    await board.close()
  }
})

test('a local board stays available by default while an explicit idle timeout closes only that server', { timeout: 30_000 }, async () => {
  const persistent = await page()
  const timed = await page('', {}, ['--idle-minutes', '0.02'])
  try {
    assert.equal((await persistent.call('GET', '/api/ping')).json().idleMs, 0)
    assert.equal((await timed.call('GET', '/api/ping')).json().idleMs, 1200)
    assert.ok((await persistent.call('GET', '/?t=' + persistent.token)).body.includes('The local board stays running'))
    assert.ok((await timed.call('GET', '/?t=' + timed.token)).body.includes('after 0.02 minutes unused'))
    await new Promise(done => setTimeout(done, 2600))
    assert.equal((await persistent.call('GET', '/api/board')).status, 200)
    assert.equal(await Promise.race([timed.exited, new Promise(done => setTimeout(() => done('still running'), 2500))]), 0)
    assert.equal(existsSync(timed.served), false)
  } finally { await persistent.close(); await timed.close() }
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
    const at = ago(60_000)
    const block = `## launch\n<!-- auto session=c0ffee12 agent=muse state=waiting updated=${at} -->\n### Draft the launch post\n- [x] Outline\n- [?] Ship it Friday, OK?\n<!-- /auto session=c0ffee12 -->`
    const pasted = await call('POST', '/api/paste', { body: { text: `Here it is:\n\`\`\`\n${block}\n\`\`\`\n` } })
    assert.equal(pasted.status, 200, pasted.body)
    assert.ok(readFileSync(path, 'utf8').includes('## launch\n\n<!-- auto session=c0ffee12 agent=muse state=waiting updated='))
    assert.ok(readFileSync(path, 'utf8').includes(`updated=${at}`))
    const refused = await call('POST', '/api/paste', { body: { text: block.replaceAll('c0ffee12', 'b2c3d4e5') } })
    assert.equal(refused.status, 409)
    assert.ok(readFileSync(path, 'utf8').includes(`resume=${GROK_ID}`))
    // Matching an agent's name does not grant a pasted block its local ownership.
    const beforeSpoof = readFileSync(path, 'utf8')
    const spoofed = await call('POST', '/api/paste', { body: { text: block.replaceAll('c0ffee12', 'b2c3d4e5').replace('agent=muse', 'agent=grok') } })
    assert.equal(spoofed.status, 409)
    assert.equal(readFileSync(path, 'utf8'), beforeSpoof)
  } finally {
    await board.close()
  }
})

const relayFragment = (at, state = 'waiting', step = '- [?] Ship it Friday, OK?') => `## launch\n<!-- auto session=c0ffee12 agent=muse state=${state} updated=${at} -->\n### Draft the launch post\n${step}\n<!-- /auto session=c0ffee12 -->`

test('the board script refuses a pasted working block with a weeks-old clock in every language and writes nothing', { timeout: 30_000 }, async () => {
  const notes = { en: /21 days behind.*nothing was written/i, 'zh-TW': /慢了 21 天.*未寫入/, 'zh-CN': /慢了 21 天.*未写入/ }
  for (const [lang, note] of Object.entries(notes)) {
    const board = await page('', {}, ['--lang', lang])
    try {
      const before = '# Progress\n\n## launch\n'
      writeFileSync(board.path, before)
      await board.call('GET', '/api/board')
      const files = readdirSync(board.dir).sort()
      const mtime = statSync(board.path).mtimeMs
      for (const state of ['working', 'waiting']) {
        const fragment = relayFragment(ago(21 * 24 * 60 * 60 * 1000), state, '- [~] Outline')
        const result = await board.call('POST', '/api/paste', { body: { text: fragment } })
        assert.equal(result.status, 409, result.body)
        assert.match(result.json().note, note)
        assert.doesNotMatch(result.json().note, /c0ffee12|progress\.md|launch/)
        assert.equal(readFileSync(board.path, 'utf8'), before)
        assert.equal(statSync(board.path).mtimeMs, mtime)
        assert.deepEqual(readdirSync(board.dir).sort(), files)
      }
      // The board exposes tidy through its page, rather than a --tidy CLI flag.
      const tidied = await board.call('POST', '/api/tidy', { body: {} })
      assert.equal(tidied.status, 200, tidied.body)
      assert.equal(readFileSync(board.path, 'utf8'), before)
      assert.deepEqual(readdirSync(board.dir).sort(), files)
      assert.equal(files.some(name => name.includes('-archive-')), false)
    } finally { await board.close() }
  }
})

test('chat relay keeps newer progress and refuses an older question on both local and LAN imports', { timeout: 30_000 }, async t => {
  const board = await page()
  try {
    const local = text => board.call('POST', '/api/paste', { body: { text } })
    const senders = [local]
    const opened = await board.call('POST', '/api/lan', { body: {} })
    if (opened.status === 200) {
      const lan = new URL(opened.json().url)
      senders.push(text => fetchAt(lan.hostname, Number(lan.port), 'POST', '/api/paste', { 'x-board-token': lan.searchParams.get('t') }, { text }))
    } else t.diagnostic('No private network address: LAN listener untested; loopback path still exercised.')
    const newer = new Date(Date.now() - 60_000).toISOString()
    const older = new Date(Date.now() - 120_000).toISOString()
    assert.equal((await local(relayFragment(newer, 'done', '- [x] Ship it Friday'))).status, 200)
    const before = readFileSync(board.path, 'utf8')
    assert.ok(before.includes(`updated=${newer}`), 'source timestamp must survive import')
    for (const send of senders) {
      const result = await send(relayFragment(older))
      assert.equal(result.status, 409, result.body)
      assert.match(result.json().note, /older/i)
      assert.equal(readFileSync(board.path, 'utf8'), before)
    }
  } finally { await board.close() }
})

test('chat relay repeated imports change neither bytes nor freshness and equal-time edits conflict', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const at = new Date(Date.now() - 60_000).toISOString()
    const fragment = relayFragment(at)
    assert.equal((await board.call('POST', '/api/paste', { body: { text: fragment } })).status, 200)
    const before = readFileSync(board.path, 'utf8')
    utimesSync(board.path, 1, 1)
    const mtime = statSync(board.path).mtimeMs
    const repeated = await board.call('POST', '/api/paste', { body: { text: fragment } })
    assert.equal(repeated.status, 200, repeated.body)
    assert.match(repeated.json().note, /unchanged/i)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    assert.equal(statSync(board.path).mtimeMs, mtime)
    const conflict = await board.call('POST', '/api/paste', { body: { text: relayFragment(at, 'done', '- [x] Ship it Friday') } })
    assert.equal(conflict.status, 409, conflict.body)
    assert.match(conflict.json().note, /same source time/i)
    assert.equal(readFileSync(board.path, 'utf8'), before)
  } finally { await board.close() }
})

test('chat relay refuses unknown and future source clocks without inventing an update time', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const before = readFileSync(board.path, 'utf8')
    for (const at of ['', 'not-a-time', '2026-02-30T00:00:00Z', '2026-01-01T00:00:00', new Date(Date.now() + 60_000).toISOString()]) {
      const result = await board.call('POST', '/api/paste', { body: { text: relayFragment(at) } })
      assert.equal(result.status, 409, at + ': ' + result.body)
      assert.match(result.json().note, /source time|clock/i)
      assert.equal(readFileSync(board.path, 'utf8'), before)
    }
  } finally { await board.close() }
})

test('chat relay reviews unknown historical clocks and rejects confirmations after either report changes', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const before = readFileSync(board.path, 'utf8')
    const old = relayFragment('unknown', 'working', '- [ ] Review the draft')
    writeFileSync(board.path, before + '\n' + old + '\n')
    const incoming = relayFragment(new Date(Date.now() - 60_000).toISOString(), 'done', '- [x] Review the draft')
    const send = body => board.call('POST', '/api/paste', { body })
    const first = await send({ text: incoming })
    assert.equal(first.status, 409, first.body)
    const { review } = first.json()
    assert.ok(review.token && review.current.includes('- [ ]') && review.incoming.includes('- [x]'))
    assert.ok(!review.current.includes('session='))
    assert.equal(readFileSync(board.path, 'utf8'), before + '\n' + old + '\n')
    assert.equal((await send({ text: incoming, reviewToken: 'approved' })).status, 409)
    const changed = await send({ text: incoming.replace('Review the draft', 'Other report'), reviewToken: review.token })
    assert.equal(changed.status, 409)
    writeFileSync(board.path, before + '\n' + old.replace('Review the draft', 'Changed meanwhile') + '\n')
    assert.equal((await send({ text: incoming, reviewToken: review.token })).status, 409)
    const fresh = await send({ text: incoming })
    const accepted = await send({ text: incoming, reviewToken: fresh.json().review.token })
    assert.equal(accepted.status, 200, accepted.body)
    assert.ok(readFileSync(board.path, 'utf8').startsWith(before))
    const newer = incoming.replace(/updated=\S+/, 'updated=' + new Date(Date.now() - 30_000).toISOString())
    assert.equal((await send({ text: newer })).status, 200)
    const latest = readFileSync(board.path, 'utf8')
    // A past review cannot override reliable newer state or local ownership.
    assert.equal((await send({ text: incoming, reviewToken: fresh.json().review.token })).status, 409)
    assert.equal(readFileSync(board.path, 'utf8'), latest)
    writeFileSync(board.path, latest.replace('agent=muse state=done', 'agent=muse owner=local state=done'))
    assert.equal((await send({ text: newer, reviewToken: fresh.json().review.token })).status, 409)
  } finally { await board.close() }
})

test('L7 locked: a locked progress.md is one plain sentence saying nothing was changed, with no stack trace and no full path', { timeout: 90_000 }, async () => {
  for (const code of ['EBUSY', 'EAGAIN']) {
    for (const [lang, note] of [
      ['en', 'Another program has your progress file open; nothing was changed.'],
      ['zh-TW', '其他程式正在使用你的進度檔，沒有改動任何檔案。'],
      ['zh-CN', '其他程序正在使用你的进度文件，没有改动任何文件。'],
    ]) {
      const preload = questionFault(`const original = fs.readFileSync
fs.readFileSync = (file, ...args) => { if (file === path.join(__dirname, 'progress.md')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: '${code}' }); return original(file, ...args) }`)
      for (const args of [[], ['--keys', 'q'], ['--chat']]) {
        const ran = chatRun(args, { lang, preload })
        assert.equal(ran.status, 1, ran.stderr)
        assert.equal(ran.stdout + ran.stderr, `${note}\n`)
        assert.equal(args.includes('--chat') ? ran.stderr : ran.stdout, '')
        assert.doesNotMatch(ran.stdout + ran.stderr, /\bat |may already be saved/)
        assert.ok(!`${ran.stdout}${ran.stderr}`.includes(ran.home), ran.stdout + ran.stderr)
      }
      const watched = chatRun(['--watch'], { lang, preload: preload + `
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => { const result = write(chunk, ...args); if (String(chunk).includes(${JSON.stringify(note)})) process.exit(1); return result }
` })
      assert.equal(watched.status, 1, watched.stderr)
      assert.equal(watched.stderr, `${note}\n`)
      assert.equal(watched.stdout, `\u001b[2J\u001b[H${note}\n`)
    }
    const faults = mkdtempSync(join(tmpdir(), 'board-locked-'))
    const preload = join(faults, 'fault.cjs')
    const lock = join(faults, 'locked')
    writeFileSync(lock, '')
    writeFileSync(preload, `const fs = require('node:fs')
const { basename } = require('node:path')
const original = fs.readFileSync
fs.readFileSync = (file, ...args) => { if (basename(String(file)) === 'progress.md' && fs.existsSync(${JSON.stringify(lock)})) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: '${code}' }); return original(file, ...args) }
require('node:module').syncBuiltinESMExports()
`)
    let board
    try {
      board = await page('', { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
      const note = 'Another program has your progress file open; nothing was changed.'
      const seen = await board.call('GET', '/api/board')
      assert.equal(seen.status, 409, seen.body)
      assert.equal(seen.json().note, note)
      const opened = await board.call('POST', '/api/lan', { body: {} })
      if (opened.status === 200) {
        const lan = new URL(opened.json().url)
        const far = await fetchAt(lan.hostname, Number(lan.port), 'GET', '/api/board', { 'x-board-token': lan.searchParams.get('t') })
        assert.equal(far.status, 409, far.body)
        assert.equal(far.json().note, note)
      }
      rmSync(lock)
      const printed = spawnSync(process.execPath, [join(board.dir, 'agent-board.mjs')], {
        env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, NO_COLOR: '1' },
        encoding: 'utf8', timeout: 5000,
      })
      assert.equal(printed.status, 0, printed.stderr)
      assert.ok(printed.stdout.includes('Fabrikam fellowship'), printed.stdout)
      assert.equal(printed.stderr, '')
      assert.equal((await board.call('GET', '/api/board')).status, 200)
    } finally {
      try { if (board) await board.close() } finally { rmSync(faults, { recursive: true, force: true }) }
    }
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
    assert.match(seen.json().note, /^Couldn't safely read or update .*-journal-.*\(it is read-only or locked\)/)
    // The page says that note, and "offline" only when the board sent none.
    const home = await board.call('GET', `/?t=${board.token}`, { headers: { 'x-board-token': '' } })
    const dom = await pageDom(home.body, null, { getBoard: async () => ({ ok: false, json: async () => seen.json() }) })
    assert.equal(dom.node('note').textContent, seen.json().note)
    assert.equal(dom.node('offline').textContent, '')
    assert.ok(dom.allButtons().some(button => !button.disabled))
    // A phone on the network is told the file's name, not the folder it is in, which names the
    // person's account.
    const opened = await board.call('POST', '/api/lan', { body: {} })
    if (opened.status === 200) {
      const lan = new URL(opened.json().url)
      const far = await fetchAt(lan.hostname, Number(lan.port), 'GET', '/api/board', { 'x-board-token': lan.searchParams.get('t') })
      assert.equal(far.status, 409, far.body)
      assert.match(far.json().note, /^Couldn't safely read or update progress-journal-\d{4}-\d{2}\.md \(it is read-only or locked\)/)
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
    const now = new Date()
    const journal = `progress-journal-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.md`
    assert.equal(ticked.json().note, EN.boardStorageFailed(EN.fileNamed(journal), EN.storageUnknown))
    assert.equal(readFileSync(path, 'utf8'), before)
    // The page runs on, with the step still there to tick again.
    assert.equal((await call('GET', '/api/board')).status, 200)
    assert.ok(await keyOf('Fabrikam fellowship'))
  } finally {
    await board.close()
    rmSync(faults, { recursive: true, force: true })
  }
})

test('a press that wrote its history before progress.md was locked says files may have changed, not that nothing was', { timeout: 30_000 }, async () => {
  // The tick writes the journal first. Then another program holds progress.md: the rename onto
  // it is refused, and every read of it after that is too. The journal is held from then on
  // as well, so the tick cannot take its line back (#248) and the history stays saved.
  const faults = mkdtempSync(join(tmpdir(), 'board-fault-'))
  const preload = join(faults, 'fault.cjs')
  writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
let isHeld = false
const isBoard = file => String(file).endsWith('progress.md')
const isJournal = file => /progress-journal-[0-9-]+[.]md$/.test(String(file))
const rename = fs.renameSync
const read = fs.readFileSync
fs.renameSync = (from, to) => {
  if (isBoard(to)) { isHeld = true; throw Object.assign(new Error('injected rename refusal'), { code: 'EPERM' }) }
  if (isHeld && isJournal(to)) throw Object.assign(new Error('injected journal refusal'), { code: 'EPERM' })
  return rename(from, to)
}
fs.readFileSync = (file, ...args) => { if (isHeld && isBoard(file)) throw Object.assign(new Error('injected busy read'), { code: 'EBUSY' }); return read(file, ...args) }
syncBuiltinESMExports()
`)
  const board = await page('', { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  try {
    const { call, keyOf, rowOf } = board
    const ticked = await call('POST', '/api/act', { body: { key: await keyOf('Fabrikam fellowship'), type: 'tick', text: 'Ask two referees', fp: (await rowOf('Fabrikam fellowship')).fp } })
    assert.equal(ticked.status, 409, ticked.body)
    assert.match(ticked.json().note, /^Couldn't safely read or update your progress file \(another program is using it\), and some changes may already be saved;/)
    assert.doesNotMatch(ticked.json().note, /nothing was changed/)
    // The page reads the board again right after every press, and that note replaces the press's.
    const refreshed = await call('GET', '/api/board')
    assert.equal(refreshed.status, 409, refreshed.body)
    assert.match(refreshed.json().note, /some changes may already be saved/)
    assert.doesNotMatch(refreshed.json().note, /nothing was changed/)
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
    assert.equal(hid.json().note, EN.boardStorageFailed(EN.fileNamed('progress-answered.json'), EN.storageUnknown))
    assert.ok(!existsSync(join(dir, 'progress-answered.json')))
    assert.ok(!readdirSync(dir).some(name => name.endsWith('.board-tmp')))
    // The question is still asked on the page.
    assert.ok((await call('GET', '/api/board')).json().model.asks.some(one => one.key === ask.key))
  } finally {
    await board.close()
    rmSync(faults, { recursive: true, force: true })
  }
})

test('with explicit legacy opt-in a reply goes into a closed Grok session once, in its own folder, and the page waits for its answer before it closes', { timeout: 30_000 }, async () => {
  const board = await page('', {}, ['--allow-resume'])
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
const pageDom = async (html, first, { post, confirm, messaging, copyAllowed = false, currentModel, currentBoard, getBoard, clipboard = false } = {}) => {
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
      this.textWrites = 0
    }
    set textContent(value) {
      this.textWrites += 1
      this.text = value
      this.childNodes = []
    }
    get textContent() {
      return this.text + this.childNodes.map(child => child.textContent).join('')
    }
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    }
    removeChild(child) {
      this.childNodes = this.childNodes.filter(one => one !== child)
    }
    insertAdjacentElement(position, child) {
      assert.equal(position, 'afterend')
      get('main').appendChild(child)
    }
    get firstChild() { return this.childNodes[0] ?? null }
    insertBefore(child, before) {
      child.parentNode = this
      const index = this.childNodes.indexOf(before)
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
      return child
    }
    remove() {
      this.parentNode?.removeChild(this)
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
    querySelectorAll(selector = 'textarea[data-key]') {
      return this.childNodes.flatMap(child => {
        const isMatch = matches(child, selector)
        return [...(isMatch ? [child] : []), ...child.querySelectorAll(selector)]
      })
    }
    click() {
      if (!this.disabled) this.events.click?.()
    }
    focus() {}
    setSelectionRange() {}
    select() { this.isSelected = true }
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id))
    return nodes.get(id)
  }
  get('words').textContent = html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1]
  get('.pfoot').appendChild(get('close'))
  for (const id of ['close', 'paste-go', 'relay']) get(id).tag = 'button'
  const matches = (node, selector) => {
    if (selector === 'button') return node.tag === 'button'
    if (selector === 'button:not([data-local])') return node.tag === 'button' && node.getAttribute('data-local') === null
    if (selector === 'button[data-static]') return node.tag === 'button' && node.getAttribute('data-static') !== null
    return node.tag === 'textarea' && node.getAttribute('data-key') !== null
  }
  for (const found of html.matchAll(/<button\b([^>]*)>/g)) {
    const id = found[1].match(/id="([^"]+)"/)?.[1]
    if (!id) continue
    for (const attr of ['data-local', 'data-static']) if (found[1].includes(attr)) get(id).setAttribute(attr, '')
  }
  const copied = []
  const copies = []
  const document = {
    getElementById: get,
    createElement: tag => new Element(tag),
    createTextNode: text => {
      const node = new Element('text')
      node.textContent = text
      return node
    },
    querySelector: get,
    querySelectorAll: selector => [...nodes.values()].flatMap(node => [...(matches(node, selector) ? [node] : []), ...node.querySelectorAll(selector)]),
    activeElement: null,
    events: {},
    addEventListener(name, run) { this.events[name] = run },
    body: new Element('body'),
    execCommand: () => { copies.push(document.body.childNodes.find(node => node.tag === 'textarea')?.value); return copyAllowed },
  }
  let model = first
  let scheduled
  const requests = []
  const pending = new Set()
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(found => found[1]).find(code => code.includes('(function ()'))
  runInNewContext(script, {
    document,
    location: { search: '?t=x' },
    URLSearchParams,
    navigator: clipboard ? { clipboard: { writeText: async text => { copied.push(text) } } } : {},
    window: { confirm, isSecureContext: !!clipboard },
    crypto: { randomUUID: () => 'synthetic-offline-attempt' },
    setTimeout: run => {
      scheduled = run
      return 1
    },
    clearTimeout: () => {},
    fetch: (target, options) => {
      const response = (async () => {
        if (target === '/api/board') return getBoard ? getBoard() : { ok: true, json: async () => ({ model: currentModel ? currentModel() : model, now: 1, messaging, ...currentBoard?.() }) }
        requests.push({ path: target, body: JSON.parse(options.body) })
        if (post) return post(requests.at(-1))
        return { ok: true, json: async () => ({ note: '' }) }
      })()
      pending.add(response)
      response.then(() => pending.delete(response), () => pending.delete(response))
      return response
    },
  }, { timeout: 1000 })
  const flush = () => new Promise(done => setImmediate(done))
  const settle = async () => {
    do {
      await Promise.allSettled([...pending])
      await new Promise(done => setImmediate(done))
    } while (pending.size)
  }
  await flush()
  const boardButtons = node => node.childNodes.flatMap(child => [...(child.tag === 'button' ? [child] : []), ...boardButtons(child)])
  return {
    buttons: () => boardButtons(get('board')),
    boxes: () => get('board').querySelectorAll(),
    send: () => boardButtons(get('board')).find(button => button.textContent === 'Send to grok'),
    requests, copies,
    copied,
    allButtons: () => document.querySelectorAll('button'),
    node: get,
    key: event => document.events.keydown?.(event),
    flush,
    settle,
    redraw: async next => {
      model = next
      scheduled()
      await flush()
    },
  }
}

const pageCard = button => {
  for (let node = button.parentNode; node; node = node.parentNode) if (node.getAttribute('data-card-key') !== null) return node
  assert.fail(`No card owns ${button.textContent}`)
}

const pageCardResults = (dom, key) => {
  const card = pressWalk(dom.node('board')).find(node => node.getAttribute('data-card-key') === key)
  assert.ok(card, `The pressed card ${key} must still own its result slot`)
  return pressWalk(card).filter(node => node.className?.includes('press-result'))
}

const pageHasCard = (model, key) => [
  ...model.asks, ...model.groups.flatMap(group => group.rows), ...model.hidden,
  ...model.idle, ...model.stopped, ...model.turns, ...(model.reminder ?? []), ...(model.older ?? []),
].some(item => item.key === key) || key === 'recent' && model.recent.length > 0

const pageLostResults = (dom, label) => {
  const card = dom.node('board').childNodes.find(node => node.tag === 'article' && node.childNodes.some(child => child.className === 'where' && child.textContent === label))
  assert.ok(card, `The removed card must leave a result labelled ${label}`)
  return pressWalk(card).filter(node => node.className?.includes('press-result'))
}

test('the serve page and the terminal board answer every action with a visible line', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const model = {
      counts: { waiting: 1, active: 1, due: 0, today: 1 },
      asks: [{ key: 'ask-demo', task: 'Question card', project: 'Demo', text: 'Ship it, OK?', kind: 'confirm', chip: 'Confirm', answers: ['Yes', 'No'], canTick: true, canHide: true, command: 'echo demo', reopen: 'claude --resume synthetic-session', send: 'copy', fp: 'first' }],
      groups: [{ project: 'Demo', rows: [{ key: 'row-demo', title: 'Task card', next: 'Next step', canArchive: true, canConfirm: true, resume: 'claude --resume synthetic-session', steps: [], send: 'copy', hasCopyBox: true, fp: 'first' }] }],
      hidden: [{ key: 'hidden:demo', task: 'Hidden card', text: 'Hidden question', project: 'Demo' }],
      idle: [], stopped: [], turns: [], recent: [{ project: 'Demo', title: 'Finished card', when: 'Just now' }],
    }
    const first = await pageDom(html, model)
    const labels = first.buttons().map(button => button.textContent)
    for (const [index, label] of labels.entries()) {
      const dom = await pageDom(html, model, { post: async () => { throw new Error('synthetic offline') } })
      dom.boxes().forEach(box => { box.value = 'A synthetic reply' })
      const button = dom.buttons()[index]
      const key = pageCard(button).getAttribute('data-card-key')
      button.click()
      await dom.flush()
      await dom.flush()
      const isCopy = /Copy|Yes|No/.test(label)
      // Read the board again at once so the offline advice becomes the plain failure.
      if (!isCopy) await dom.redraw(model)
      const results = pageCardResults(dom, key).filter(node => node.textContent)
      assert.ok(results.length, `no result beside ${label}`)
      assert.ok(results.some(node => node.textContent.includes(isCopy ? words.boardCopyFailedBelow : words.pressFailed)), label)
      if (isCopy) assert.ok(results.some(node => node.childNodes.some(child => child.tag === 'textarea' && child.isSelected)), label)
    }
    for (const response of [
      { ok: true, json: async () => ({ note: 'Saved here' }) },
      { ok: false, json: async () => ({ note: 'The row changed' }) },
      { ok: false, json: async () => ({}) },
      { ok: true, json: async () => { throw new Error('invalid JSON') } },
    ]) {
      const dom = await pageDom(html, model, { post: async () => response })
      dom.buttons().find(button => button.textContent === words.answeredHide).click()
      await dom.flush()
      await dom.flush()
      const expected = response.ok ? (await response.json().catch(() => ({}))).note || words.pressDone : (await response.json()).note || words.pressFailed
      assert.ok(pageCardResults(dom, 'ask-demo').some(node => node.textContent === expected))
    }
    for (const key of ['x', 'a', 'd', 'c', 'h', 'u', 'enter', 'i', 'l']) {
      const terminal = run('en', ['--keys', key])
      const lines = terminal.trimEnd().split('\n')
      const footer = lines.findIndex(line => /[↑↓]/.test(line))
      assert.ok(lines.some((line, index) => index !== footer && /nothing to change|Done:|Copied|copy it from here|Hidden:|Shown|Opened|Closed|Archived/.test(line)), `no press result for ${key}: ${terminal}`)
    }
  } finally { await board.close() }
})


const PRESS_HOSTS = ['claude', 'codex', 'antigravity', 'hermes', 'openclaw', 'grok', 'opencode', 'cursor']
const PRESS_KINDS = ['needs-you', 'live-ask', 'stopped', 'unknown-session', 'blocked', 'done', 'hidden', 'own-block', 'ended', 'hand-kept', 'retained', 'inbox']
const PRESS_CELLS = PRESS_HOSTS.flatMap(agent => ['own', 'other'].flatMap(source => PRESS_KINDS.map(kind => ({ agent, source, kind, title: `${kind} ${agent} ${source}` }))))
const PRESS_NOW = Date.parse('2026-10-17T09:00:00Z')
const pressWalk = node => [node, ...node.childNodes.flatMap(pressWalk)]

// Exercise the generated entry point's real actions without launching its interactive loop.
// Only the external clipboard and filesystem boundaries are replaced during an action.
const pressRuntime = async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-press-matrix-'))
  const script = join(root, 'worker.mjs')
  const path = join(root, 'progress.md')
  const originalWrite = fs.writeFileSync
  const originalRead = fs.readFileSync
  const originalStat = fs.statSync
  const originalReadDir = fs.readdirSync
  const originalRename = fs.renameSync
  const originalUnlink = fs.unlinkSync
  const readCache = new Map()
  const originalSpawn = childProcess.spawnSync
  const gate = { failing: false, active: false }
  const copies = []
  const inside = file => typeof file === 'string' && resolve(file).startsWith(resolve(root) + sep)
  const write = (file, text) => { originalWrite(file, text); utimesSync(file, PRESS_NOW / 1000, PRESS_NOW / 1000) }
  try {
    const skipped = BOARD_SCRIPT.replace(/await \w+\(\);(?=\s*\}\s*catch \(error\))/, '')
    assert.notEqual(skipped, BOARD_SCRIPT, 'the generated entry point must be disabled before import')
    const old = PRESS_NOW - 10 * 86400000
    const header = `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\nconst fixtureClock = { now: ${old} };\nconst Date = class extends globalThis.Date { constructor(...args) { super(...(args.length ? args : [fixtureClock.now])); } static now() { return fixtureClock.now; } };\n`
    write(script, `${header}${skipped}\nexport { view, pending, act, press, boardItems, boardKey, boardScreen, pinned, emptyBoardState, serveModel, serveAction, tidy, failureNote, s, fixtureClock, path, buildView, parseProgress, fit };\n`)
    const blocks = new Map()
    for (const [index, cell] of PRESS_CELLS.entries()) {
      if (cell.kind === 'inbox') continue
      const session = (index + 1).toString(16).padStart(8, '0')
      const state = cell.kind === 'done' ? 'done' : ['stopped', 'unknown-session', 'ended'].includes(cell.kind) ? 'ended' : 'waiting'
      const updated = new Date(cell.kind === 'retained' ? old : PRESS_NOW - 60000).toISOString()
      const step = ['needs-you', 'live-ask', 'hidden', 'retained'].includes(cell.kind) ? `- [?] ${cell.title}, OK?` : cell.kind === 'blocked' ? '- [!] A synthetic dependency' : cell.kind === 'done' ? '- [x] Finished step' : '- [ ] Next step'
      blocks.set(cell.title, cell.kind === 'hand-kept' ? `### ${cell.title}\n- [?] ${cell.title}, OK?\n` : `<!-- auto session=${session} agent=${cell.agent} state=${state} updated=${updated}${cell.kind === 'unknown-session' ? '' : ` resume=${session}`} -->\n### ${cell.title}\n${step}\n<!-- /auto session=${session} -->\n`)
    }
    write(path, '# Progress\n\n## Matrix\n' + PRESS_CELLS.filter(cell => cell.kind === 'retained').map(cell => blocks.get(cell.title)).join('\n'))
    const previous = globalThis.AGENT_BOARD
    const previousArgs = process.argv
    const previousProgress = process.env.CLAUDE_PROGRESS_FILE
    let runtime
    try {
      process.argv = [process.execPath, script, '--keys', 'q']
      delete process.env.CLAUDE_PROGRESS_FILE
      runtime = await import(pathToFileURL(script).href)
      assert.equal(resolve(runtime.path), resolve(path), 'matrix actions must use the temporary progress file')
    } finally {
      globalThis.AGENT_BOARD = previous; process.argv = previousArgs
      if (previousProgress === undefined) delete process.env.CLAUDE_PROGRESS_FILE
      else process.env.CLAUDE_PROGRESS_FILE = previousProgress
    }
    runtime.view()
    runtime.fixtureClock.now = PRESS_NOW
    write(path, '# Progress\n\n## Matrix\n' + PRESS_CELLS.filter(cell => cell.kind !== 'retained' && cell.kind !== 'inbox').map(cell => blocks.get(cell.title)).join('\n'))
    const inbox = join(root, 'progress-inbox')
    mkdirSync(inbox)
    for (const [index, cell] of PRESS_CELLS.entries()) if (cell.kind === 'inbox') {
      write(join(inbox, `${cell.agent}-turn-${PRESS_NOW / 1000}-${index}.json`), JSON.stringify({ session_id: `matrix-${cell.agent}-${cell.source}`, cwd: '/work/Matrix', last_assistant_message: `${cell.title}, OK?` }))
    }
    const preview = runtime.view()
    const hidden = preview.waiting.filter(ask => ask.task.startsWith('hidden ')).map(ask => ask.hideKey)
    assert.equal(hidden.length, 16)
    write(join(root, 'progress-answered.json'), JSON.stringify({ answered: hidden }))
    runtime.view()
    const baseline = new Map()
    const capture = directory => {
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, name.name)
        if (file === script) continue
        if (name.isDirectory()) capture(file)
        else baseline.set(file, readFileSync(file))
      }
    }
    capture(root)
    const snapshots = new Map()
    const reset = cell => {
      gate.active = false
      copies.length = 0
      readCache.clear()
      let selected = snapshots.get(cell.title)
      if (selected === undefined) {
        selected = new Map()
        const ledger = JSON.parse(baseline.get(join(root, 'progress-questions.json')).toString())
        ledger.records = ledger.records.filter(record => JSON.stringify(record.source).includes(cell.title))
        const identities = new Set(ledger.records.map(record => record.id))
        for (const [file, bytes] of baseline) {
          if (file === path) selected.set(file, Buffer.from('# Progress\n\n## Matrix\n' + (['retained', 'inbox'].includes(cell.kind) ? '' : blocks.get(cell.title))))
          else if (file === join(root, 'progress-questions.json')) selected.set(file, Buffer.from(JSON.stringify(ledger)))
          else if (file === join(root, 'progress-answered.json')) selected.set(file, Buffer.from(JSON.stringify({ answered: JSON.parse(bytes.toString()).answered.filter(key => identities.has(key)) })))
          else if (bytes.toString().includes(cell.title)) selected.set(file, bytes)
        }
        snapshots.set(cell.title, selected)
      }
      const removeNew = directory => {
        for (const name of readdirSync(directory, { withFileTypes: true })) {
          const file = resolve(directory, name.name)
          assert.ok(file.startsWith(resolve(root) + sep))
          if (name.isDirectory()) { removeNew(file); if (readdirSync(file).length === 0) fs.rmdirSync(file) }
          else if (file !== script && !selected.has(file)) rmSync(file)
        }
      }
      removeNew(root)
      for (const [file, text] of selected) if (!existsSync(file) || !readFileSync(file).equals(text)) { mkdirSync(resolve(file, '..'), { recursive: true }); write(file, text) }
      readCache.clear()
      runtime.fixtureClock.now = PRESS_NOW
    }
    // Only this fixture writes these files. Repeated polls may reuse reads until a write,
    // rename or unlink, while every mutation still reaches the real filesystem.
    fs.readFileSync = (file, ...args) => {
      if (!inside(file)) return originalRead(file, ...args)
      const key = JSON.stringify([file, ...args])
      if (!readCache.has(key)) readCache.set(key, originalRead(file, ...args))
      const value = readCache.get(key)
      return Buffer.isBuffer(value) ? Buffer.from(value) : value
    }
    fs.statSync = (file, ...args) => {
      if (!inside(file)) return originalStat(file, ...args)
      const key = JSON.stringify(['stat', file, ...args])
      if (!readCache.has(key)) readCache.set(key, originalStat(file, ...args))
      return readCache.get(key)
    }
    fs.readdirSync = (file, ...args) => {
      if (!inside(file) && file !== root) return originalReadDir(file, ...args)
      const key = JSON.stringify(['directory', file, ...args])
      if (!readCache.has(key)) readCache.set(key, originalReadDir(file, ...args))
      return [...readCache.get(key)]
    }
    fs.renameSync = (...args) => { readCache.clear(); return originalRename(...args) }
    fs.unlinkSync = (...args) => { readCache.clear(); return originalUnlink(...args) }
    fs.writeFileSync = (file, ...args) => {
      readCache.clear()
      if (gate.active && gate.failing && inside(String(file))) throw Object.assign(new Error('synthetic write refusal'), { code: 'EACCES' })
      return originalWrite(file, ...args)
    }
    childProcess.spawnSync = (...args) => { copies.push(args.at(-1)?.input); return { status: gate.failing ? 1 : 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] } }
    syncBuiltinESMExports()
    const fullView = runtime.view()
    // The real Recent shelf shows only three entries. Inventory each finished card with the
    // same pure view builder, so the complete host table is independent of that display cap.
    fullView.recent = PRESS_CELLS.filter(cell => cell.kind === 'done').flatMap(cell => runtime.buildView(runtime.parseProgress('# Progress\n\n## Matrix\n' + blocks.get(cell.title)), [], null, PRESS_NOW, 0, {}, runtime.s).recent)
    return {
      root, path, runtime, reset, copies, fullView, fullPending: runtime.pending(),
      enable: failing => { gate.failing = failing; gate.active = true },
      disable: () => { gate.active = false; process.exitCode = 0 },
      close: () => {
        gate.active = false
        fs.writeFileSync = originalWrite
        fs.readFileSync = originalRead
        fs.statSync = originalStat
        fs.readdirSync = originalReadDir
        fs.renameSync = originalRename
        fs.unlinkSync = originalUnlink
        childProcess.spawnSync = originalSpawn
        syncBuiltinESMExports()
        process.exitCode = 0
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
        rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    fs.writeFileSync = originalWrite
    fs.readFileSync = originalRead
    fs.statSync = originalStat
    fs.readdirSync = originalReadDir
    fs.renameSync = originalRename
    fs.unlinkSync = originalUnlink
    childProcess.spawnSync = originalSpawn
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

const pressItemFor = (items, title) => items.find(item => item.type === 'ask' ? item.ask.task === title || item.ask.text.startsWith(title) : item.type === 'row' ? item.row.title === title : item.turn.text.startsWith(title))
const pressKeysFor = item => item.type === 'ask'
  ? ['enter', ...(item.ask.step === null ? [] : ['x']), ...(item.ask.hideKey === '' || item.ask.canHide === false ? [] : ['h']), ...((item.ask.command ?? item.ask.link) !== null || item.ask.reopen !== null ? ['c'] : []), ...(item.ask.kind === 'confirm' ? ['y', 'n'] : item.ask.options.map((_, index) => String(index + 1)))]
  : item.type === 'row' ? ['enter', ...(item.row.next === null ? [] : ['x']), ...(item.row.archive === null ? [] : ['a']), ...(item.row.confirm == null ? [] : ['d']), ...(item.row.resume === null ? [] : ['c'])] : ['enter']
const pressExpected = (runtime, action) => action.type === 'copy' ? runtime.s.copied
  : action.type === 'tick' ? runtime.s.boardTicked(action.ref.step)
    : action.type === 'archive' ? runtime.s.archivedOne(action.title)
      : action.type === 'done' ? runtime.s.confirmedDone(action.title)
        : action.type === 'hide' ? runtime.s.boardHidden(action.text) : runtime.s.boardShown

const pressChanged = (fixture, action, context) => {
  const { runtime } = fixture
  if (action.type === 'copy') {
    assert.ok(fixture.copies.length > 0, `${context}: clipboard boundary was called`)
    assert.ok(fixture.copies.every(text => text === action.text), `${context}: exact text reached the clipboard`)
  } else if (action.type === 'hide') assert.ok(runtime.view().hidden.some(ask => ask.hideKey === action.key), context)
  else if (action.type === 'unhide') assert.equal(runtime.view().hidden.length, 0, context)
  else if (action.type === 'tick') assert.ok(readFileSync(fixture.path, 'utf8').includes(`- [x] ${action.ref.step}`), context)
  else if (action.type === 'done') {
    const text = readFileSync(fixture.path, 'utf8')
    assert.ok(text.includes(`### ${action.title}`) && text.includes('- [x] '), context)
    assert.ok(!/^- \[[ ?~!]\]/m.test(text), context)
  }
  else if (action.type === 'archive') {
    assert.ok(!readFileSync(fixture.path, 'utf8').includes(`### ${action.title}`), context)
    assert.ok(readdirSync(fixture.root).filter(name => name.includes('-archive-')).some(name => readFileSync(join(fixture.root, name), 'utf8').includes(action.title)), context)
  }
}

// Both modes run the same offered keys; refused writes pass through the generated
// storage-error conversion and the same status line as an interactive terminal press.
test('every terminal board key on every card kind from every agent answers with a visible line', async () => {
  const fixture = await pressRuntime()
  const { runtime } = fixture
  const started = performance.now()
  let actions = 0
  let expectedActions = 0
  let inventory = 0
  const groups = new Set()
  const seen = new Set()
  try {
    for (const cell of PRESS_CELLS) for (const failing of [false, true]) {
      let view = fixture.fullView, pending = fixture.fullPending
      let items = runtime.boardItems(view, pending, true, true)
      let item = pressItemFor(items, cell.title)
      seen.add(cell.title)
      if (cell.kind === 'done') {
        assert.ok(view.recent.some(row => row.title === cell.title), cell.title)
        assert.equal(item, undefined, `${cell.title}: finished cards offer no terminal row keys`)
        const unavailable = runtime.boardKey(runtime.emptyBoardState, 'x', [], runtime.s)
        assert.equal(unavailable.state.note, runtime.s.pressNothing)
        continue
      }
      const keys = cell.kind === 'hidden' ? ['u'] : pressKeysFor(item ?? assert.fail(`Missing runtime card ${cell.title}`))
      inventory += keys.length
      const group = JSON.stringify([cell.kind, cell.source, keys, item?.type === 'ask' ? item.ask.reopen !== null : item?.type === 'row' ? item.row.resume !== null : false, failing])
      if (groups.has(group)) continue
      groups.add(group)
      expectedActions += keys.length
      for (const key of keys) {
        fixture.reset(cell)
        view = runtime.view(); pending = runtime.pending(); items = runtime.boardItems(view, pending, true, true)
        item = pressItemFor(items, cell.title)
        const at = item === undefined ? 0 : items.indexOf(item)
        const state = runtime.pinned({ ...runtime.emptyBoardState, selected: at, isIdleOpen: true, isOlderOpen: true }, items)
        const offered = runtime.boardKey(state, key, items, runtime.s)
        fixture.enable(failing)
        const pressed = runtime.press(state, key)
        fixture.disable()
        const note = pressed.state.note
        const width = Math.max(160, note.length + 4)
        const screen = runtime.boardScreen(view, pending, pressed.state, runtime.s, { width, isColor: false })
        const context = `${cell.title} / ${key} / ${failing ? 'refused' : 'normal'}`
        const failedFile = offered.action?.type === 'hide' || offered.action?.type === 'unhide' ? 'progress-answered.json'
          : offered.action?.type === 'archive' ? 'progress-archive-2026-10.md' : 'progress-journal-2026-10.md'
        const expected = runtime.s.boardStorageFailed(runtime.s.fileNamed(failedFile), runtime.s.storageReadOnly)
        if (key === 'enter') assert.equal(note, runtime.s.pressOpened, context)
        else if (failing && offered.action?.type === 'copy') assert.equal(note, runtime.s.boardCopyFailed(offered.action.text), context)
        else if (failing) assert.equal(note, expected, context)
        else { assert.ok(offered.action, context); assert.equal(note, pressExpected(runtime, offered.action), context) }
        if (failing && offered.action !== null && offered.action.type !== 'copy') assert.ok(screen.replace(/\s+/gu, ' ').includes(expected.replace(/\s+/gu, ' ')), context)
        else if (failing && offered.action?.type === 'copy') {
          assert.ok(screen.includes(runtime.s.boardCopyFailed('').trim()), context)
          assert.ok(screen.includes(offered.action.text), `${context}: complete copy fallback`)
        } else assert.ok(screen.includes(note), context)
        if (pressed.state.result !== undefined) {
          const lines = screen.split('\n')
          const row = lines.findIndex(line => line.startsWith('› '))
          assert.ok(row >= 0, context)
          const expected = failing && offered.action?.type === 'copy' ? runtime.s.boardCopyFailed('') : note
          assert.equal(lines[row + 1].trim(), expected.trim(), `${context}: complete result directly under the pressed row`)
        }
        if (offered.action?.type === 'copy' || (!failing && offered.action !== null)) pressChanged(fixture, offered.action, context)
        actions += 1
      }
    }
    assert.deepEqual([...seen].sort(), PRESS_CELLS.map(cell => cell.title).sort())
    assert.equal(inventory, 1072, 'all host/source terminal controls remain covered by the pure inventory')
    assert.equal(actions, 196, 'distinct normal/refused terminal controls')
    assert.equal(actions, expectedActions, 'exact grouped normal/refused terminal action inventory')
    console.log(`terminal runtime matrix: ${seen.size} cells, ${groups.size} groups, ${actions} normal/refused key presses, ${((performance.now() - started) / 1000).toFixed(3)} s`)
  } finally { fixture.close() }
})

const pressPageCell = (model, cell) => {
  const ask = model.asks.filter(one => one.task === cell.title || one.text.startsWith(cell.title))
  const groups = model.groups.map(group => ({ ...group, rows: group.rows.filter(row => row.title === cell.title) })).filter(group => group.rows.length)
  const selected = { ...model, asks: ask, groups, idle: model.idle.filter(row => row.title === cell.title), stopped: model.stopped.filter(row => row.title === cell.title), hidden: model.hidden.filter(one => one.task === cell.title), reminder: model.reminder.filter(one => one.task === cell.title), older: model.older.filter(one => one.task === cell.title), turns: model.turns.filter(one => one.text.startsWith(cell.title)), recent: model.recent.filter(one => one.title === cell.title) }
  const count = ask.length + groups.length + selected.idle.length + selected.stopped.length + selected.hidden.length + selected.reminder.length + selected.older.length + selected.turns.length + selected.recent.length
  assert.ok(count > 0, `Missing page runtime card ${cell.title}`)
  const row = [...groups.flatMap(group => group.rows), ...selected.idle, ...selected.stopped][0]
  const askButtons = ask.reduce((total, one) => total + Number(one.canTick) + one.answers.length + Number(one.command !== null) + Number(one.reopen !== null) + Number(one.canHide) + Number(!one.canTick), 0)
  const rowButtons = [...groups.flatMap(group => group.rows), ...selected.idle, ...selected.stopped].reduce((total, one) => total + Number(one.next !== null) + Number(one.canArchive) + Number(one.canConfirm) + Number(one.resume !== null) + Number(one.send === 'send' || one.send === 'connected' || one.hasCopyBox), 0)
  const expected = askButtons + rowButtons + selected.hidden.length + Number(selected.recent.length > 0)
  return { model: selected, expected, ask: ask[0], row }
}

test('every serve page action on every card kind from every agent answers with a visible line', async () => {
  const fixture = await pressRuntime()
  const { runtime } = fixture
  const board = await page()
  const started = performance.now()
  let actions = 0
  let expectedActions = 0
  let inventory = 0
  const groups = new Set()
  const seen = new Set()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    for (const cell of PRESS_CELLS) {
      const original = runtime.serveModel(fixture.fullView, fixture.fullPending, runtime.s)
      let projected = pressPageCell(original, cell)
      seen.add(cell.title)
      inventory += projected.expected * 2
      const group = JSON.stringify([cell.kind, cell.source, projected.expected, projected.ask && [projected.ask.kind, ['send', 'connected'].includes(projected.ask.send) ? projected.ask.send : 'copy', projected.ask.reopen !== null, projected.ask.canTick, projected.ask.canHide], projected.row && [['send', 'connected'].includes(projected.row.send) ? projected.row.send : 'copy', projected.row.resume !== null, projected.row.canArchive, projected.row.canConfirm]])
      if (groups.has(group)) continue
      groups.add(group)
      expectedActions += projected.expected * 2
      fixture.reset(cell)
      projected = pressPageCell(runtime.serveModel(runtime.view(), runtime.pending(), runtime.s), cell)
      for (const failing of [false, true]) for (let index = 0; index < projected.expected; index += 1) {
        fixture.reset(cell)
        let serverNote, serverExpected
        let refreshed = projected.model
        const dom = await pageDom(html, projected.model, { currentModel: () => refreshed, copyAllowed: !failing, post: async request => {
          fixture.enable(failing)
          try {
            if (request.path === '/api/tidy') { serverNote = runtime.tidy(); serverExpected = runtime.s.tidyMoved(1); if (!failing) assert.equal(runtime.view().recent.length, 0, cell.title) }
            else {
              const items = runtime.boardItems(runtime.view(), runtime.pending(), true, true)
              const action = runtime.serveAction(items, request.body, runtime.s)
              serverNote = action.type === 'refuse' ? action.note : runtime.act(action)
              serverExpected = action.type === 'refuse' ? undefined : pressExpected(runtime, action)
              if (!failing && action.type !== 'refuse') pressChanged(fixture, action, cell.title)
            }
            return { ok: true, json: async () => ({ note: serverNote }) }
          } catch (error) {
            serverNote = runtime.failureNote(error)
            return { ok: false, json: async () => ({ note: serverNote }) }
          } finally { fixture.disable(); refreshed = runtime.serveModel(runtime.view(), runtime.pending(), runtime.s) }
        } })
        assert.equal(dom.buttons().length, projected.expected, `${cell.title}: exact offered button set`)
        dom.boxes().forEach(box => { box.value = 'Synthetic reply' })
        const button = dom.buttons()[index]
        assert.ok(button, `${cell.title}: button ${index}`)
        button.click()
        await dom.flush(); await dom.flush()
        const key = pageCard(button).getAttribute('data-card-key')
        const card = [...projected.model.asks, ...projected.model.groups.flatMap(group => group.rows), ...projected.model.hidden, ...projected.model.idle, ...projected.model.stopped, ...projected.model.turns].find(one => one.key === key)
        const label = key === 'recent' ? runtime.s.sectionRecent : card?.task ?? card?.title ?? card?.project
        assert.notEqual(label, undefined, `${cell.title}: the original card has a label`)
        const results = pageHasCard(refreshed, key) ? pageCardResults(dom, key) : pageLostResults(dom, label)
        const context = `${cell.title} / ${button.textContent} / ${failing ? 'refused' : 'normal'}`
        if (serverNote !== undefined) {
          assert.ok(results.some(node => node.textContent === serverNote), context)
          if (failing) assert.ok(serverNote.includes(runtime.s.storageReadOnly), context)
          else { assert.ok(serverExpected, context); assert.equal(serverNote, serverExpected, context) }
        } else {
          const expected = failing ? runtime.s.boardCopyFailedBelow : runtime.s.copied
          assert.ok(results.some(node => node.textContent === expected), context)
          {
            const text = button.textContent === runtime.s.serveCopyResume ? projected.ask?.reopen ?? projected.row?.resume
              : button.textContent === runtime.s.serveCopyCommand ? projected.ask?.command : button.textContent === runtime.s.serveCopy ? 'Synthetic reply' : button.textContent
            assert.deepEqual(dom.copies, [text], `${context}: exact text reached the clipboard`)
            if (failing) assert.ok(results.some(node => node.childNodes.some(child => child.tag === 'textarea' && child.value === text && child.isSelected)), context)
          }
        }
        actions += 1
      }
      if (projected.expected === 0) {
        const dom = await pageDom(html, projected.model)
        assert.equal(dom.buttons().length, 0, `${cell.title}: the retained shelf is explicitly read-only`)
      }
    }
    assert.deepEqual([...seen].sort(), PRESS_CELLS.map(cell => cell.title).sort())
    assert.equal(inventory, 1040, 'all host/source page controls remain covered by the pure inventory')
    assert.equal(actions, 192, 'distinct normal/refused page controls')
    assert.equal(actions, expectedActions, 'exact grouped normal/refused page action inventory')
    console.log(`page runtime matrix: ${seen.size} cells, ${groups.size} groups, ${actions} normal/refused button presses, ${((performance.now() - started) / 1000).toFixed(3)} s`)
  } finally { await board.close(); fixture.close() }
})

test('a press on the terminal board shows its result under the pressed card', async () => {
  const fixture = await pressRuntime()
  const { runtime } = fixture
  try {
    const source = '## Demo\n### First card\n- [ ] First step\n### Second card\n- [ ] Second step\n'
    const view = runtime.buildView(runtime.parseProgress(source), [], null, PRESS_NOW, 0, {}, runtime.s)
    const items = runtime.boardItems(view, [])
    const state = runtime.pinned(runtime.emptyBoardState, items)
    const pressed = runtime.boardKey(state, 'x', items, runtime.s)
    const result = { ...pressed.state, note: runtime.s.boardTicked('First step') }
    const draw = (shown, saved = result) => runtime.boardScreen(shown, [], saved, runtime.s, { width: 160, isColor: false })
    const lines = draw(view).split('\n')
    const row = lines.findIndex(line => line.includes('First card'))
    assert.equal(lines[row + 1].trim(), result.note)
    assert.ok(row + 1 < lines.findIndex(line => line.includes('Second card')))
    assert.equal(draw(view, runtime.pinned(result, items)), draw(view), 'an unchanged redraw keeps the result')
    const unrelated = runtime.buildView(runtime.parseProgress(source.replace('Second step', 'New second step')), [], null, PRESS_NOW, 0, {}, runtime.s)
    assert.ok(draw(unrelated, runtime.pinned(result, runtime.boardItems(unrelated, []))).includes(result.note))
    const changed = runtime.buildView(runtime.parseProgress(source.replace('First step', 'New first step')), [], null, PRESS_NOW, 0, {}, runtime.s)
    assert.ok(!draw(changed, runtime.pinned(result, runtime.boardItems(changed, []))).includes(result.note))
    assert.ok(!draw(view, runtime.boardKey(result, 'down', items, runtime.s).state).includes(result.note), 'the next press clears the result')
    const noCard = runtime.boardKey(result, 'o', items, runtime.s).state
    const footer = draw(view, { ...noCard, note: 'Page opened' }).trimEnd().split('\n')
    assert.equal(footer.at(-1), 'Page opened')
    assert.match(footer.at(-2), /[↑↓]/)
  } finally { fixture.close() }
})

test('a long press result under a card wraps to the width instead of being cut', async () => {
  const fixture = await pressRuntime()
  const { runtime } = fixture
  try {
    const source = '## Demo\n### First card\n- [ ] First step\n### Second card\n- [ ] Second step\n'
    const view = runtime.buildView(runtime.parseProgress(source), [], null, PRESS_NOW, 0, {}, runtime.s)
    const items = runtime.boardItems(view, [])
    const pressed = runtime.boardKey(runtime.pinned(runtime.emptyBoardState, items), 'x', items, runtime.s)
    const note = 'The progress file could not be saved because another program is holding it open; close that program and try this step again.'
    const state = { ...pressed.state, note, tone: 'alert' }
    const width = 40
    const lines = runtime.boardScreen(view, [], state, runtime.s, { width, isColor: false }).split('\n')
    const first = lines.findIndex(line => line.includes('First card'))
    const second = lines.findIndex(line => line.includes('Second card'))
    const last = lines.findIndex((_, index) => index > first && lines.slice(first + 1, index + 1).map(line => line.trim()).join(' ') === note)
    assert.ok(first >= 0 && last > first && last < second, lines.join('\n'))
    const wrapped = lines.slice(first + 1, last + 1)
    assert.ok(wrapped.length > 1)
    assert.equal(wrapped.map(line => line.trim()).join(' '), note)
    assert.ok(wrapped.every(line => line.startsWith('    ')))
    assert.ok(wrapped.every(line => [...line].length <= width), lines.join('\n'))
    const colored = runtime.boardScreen(view, [], state, runtime.s, { width, isColor: true })
    for (const line of wrapped) assert.ok(colored.includes(`    \u001b[31m${line.trim()}\u001b[0m`))
  } finally { fixture.close() }
})

test("a background reply's result on the page appears next to its card", { timeout: 30_000 }, async () => {
  for (const agent of ['grok', 'codex']) for (const isFailing of [false, true]) {
    const extra = agent === 'codex' ? `\n## Demo\n<!-- auto session=d4e5f6a7 agent=codex state=ended updated=RECENT resume=00000000-1111-2222-3333-444444444444 dir=${encodeURIComponent(tmpdir())} -->\n### Codex card\n- [?] Keep it, OK?\n<!-- /auto session=d4e5f6a7 -->\n` : ''
    const board = await page(extra, {}, ['--allow-resume'])
    try {
      if (isFailing) writeFileSync(join(board.dir, 'grok-stand-in.mjs'), "process.stderr.write('synthetic resume refusal'); process.exit(1)\n")
      const html = (await board.call('GET', `/?t=${board.token}`)).body
      let snapshot = (await board.call('GET', '/api/board')).json()
      // A stopped session's question waits with its task (#185), so the reply goes from that row's box.
      const ask = snapshot.model.stopped.find(row => row.title === (agent === 'grok' ? 'Pick the cache' : 'Codex card'))
      assert.equal(ask?.send, 'send', agent)
      const dom = await pageDom(html, snapshot.model, {
        currentBoard: () => snapshot,
        post: async request => {
          const response = await board.call('POST', request.path, { body: request.body })
          return { ok: response.status < 400, json: async () => response.json() }
        },
      })
      const box = dom.boxes().find(node => node.getAttribute('data-key').startsWith(`${ask.key}\u0001`))
      assert.ok(box, agent)
      box.value = 'Synthetic reply'
      const send = dom.buttons().find(button => button.textContent === `Send to ${agent}` && pageCard(button).getAttribute('data-card-key') === ask.key)
      assert.ok(send, agent)
      send.click()
      await dom.flush(); await dom.flush()
      for (let tries = 0; tries < 50; tries += 1) {
        snapshot = (await board.call('GET', '/api/board')).json()
        if (snapshot.replies.length) break
        await pause(100)
      }
      const reply = snapshot.replies.find(one => one.key === ask.key)
      assert.ok(reply, `${agent}: the server keeps the pressed card key`)
      assert.equal(reply.ok, !isFailing)
      await dom.redraw(snapshot.model)
      assert.ok(pageCardResults(dom, ask.key).some(node => node.textContent === reply.note), `${agent}: result inside its own card`)
      assert.equal(dom.node('note').textContent, '')
      await dom.redraw({ ...snapshot.model, counts: { ...snapshot.model.counts, active: 9 } })
      assert.ok(pageCardResults(dom, ask.key).some(node => node.textContent === reply.note))
    } finally { await board.close() }
  }
})

test('a refused close on the page says why next to the close button', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const model = (await board.call('GET', '/api/board')).json().model
    for (const isOffline of [false, true]) {
      const dom = await pageDom(html, model, { post: async () => {
        if (isOffline) throw new Error('synthetic network refusal')
        return { ok: false, json: async () => ({ note: words.serveCloseBusy || 'A message is still on its way to an agent; close the board once it replies.' }) }
      } })
      dom.node('close').click()
      await dom.flush(); await dom.flush()
      const expected = isOffline ? words.serveOffline : 'A message is still on its way to an agent; close the board once it replies.'
      const footer = dom.node('.pfoot')
      assert.equal(footer.childNodes[0], dom.node('close'))
      assert.equal(footer.childNodes[1].textContent, expected)
      assert.equal(footer.childNodes[1].getAttribute('role'), 'status')
      assert.equal(dom.node('note').textContent, '')
      assert.ok(!dom.node('board').textContent.includes(expected))
      await dom.redraw({ ...model, counts: { ...model.counts, active: 9 } })
      // Once the server answers again, the offline advice gives way to a plain failure.
      assert.equal(footer.childNodes[1].textContent, isOffline ? words.pressFailed : expected)
      assert.equal(dom.node('offline').textContent, '')
    }
  } finally { await board.close() }
})

test('unexpected server read and action errors return a reason and log their stacks', async () => {
  const source = BOARD_SCRIPT
    .replace('\n    view: freshView,', '\n    view: () => { throw new TypeError("synthetic server read failure") },')
    .replace('\n    tidy,\n    paste,', '\n    tidy: () => { throw new TypeError("synthetic server action failure") },\n    paste,')
  assert.ok(source.includes('synthetic server read failure') && source.includes('synthetic server action failure'))
  const board = await page('', {}, [], undefined, source)
  try {
    for (const [method, route, body, reason] of [['GET', '/api/board', undefined, 'read'], ['POST', '/api/tidy', {}, 'action']]) {
      const response = await board.call(method, route, { body })
      assert.equal(response.status, 500)
      assert.equal(response.json().note, 'Could not complete this action. Please try again.')
      await new Promise(done => setImmediate(done))
      assert.ok(board.stderr().includes(`TypeError: synthetic server ${reason} failure`))
      assert.match(board.stderr(), /\n\s+at /)
    }
  } finally { await board.close() }
})

test('the board script prints an unexpected error instead of exiting silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-unexpected-'))
  try {
    const path = join(dir, 'progress.md')
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(path, FILE)
    const broken = BOARD_SCRIPT.replace(/(try\s*\{\s*)await \w+\(\);(?=\s*\}\s*catch \(error\))/, "$1throw new TypeError('synthetic unexpected failure');")
    assert.notEqual(broken, BOARD_SCRIPT)
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${broken}`)
    const ran = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /TypeError: synthetic unexpected failure/)
    assert.match(ran.stderr, /\n\s+at /)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a refusal caused by another agent's change stays next to the page card after the redraw", async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const base = { counts: { waiting: 1, active: 0, due: 0, today: 0 }, groups: [], hidden: [], idle: [], stopped: [], turns: [], recent: [] }
    const ask = { key: 'ask-race', task: 'Race card', project: 'Demo', text: 'Ship it, OK?', kind: 'confirm', chip: 'Confirm', answers: [], canTick: false, canHide: true, command: null, reopen: null, link: null, send: 'copy', fp: 'before' }
    const dom = await pageDom(html, { ...base, asks: [ask] }, { post: async () => ({ ok: false, json: async () => ({ note: 'That line just changed' }) }) })
    const hide = dom.buttons().find(button => button.textContent === words.answeredHide)
    assert.ok(hide)
    hide.click()
    await dom.flush()
    await dom.flush()
    await dom.redraw({ ...base, asks: [{ ...ask, fp: 'after' }] })
    const results = pageCardResults(dom, ask.key).filter(node => node.textContent !== '')
    assert.deepEqual(results.map(node => node.textContent), ['That line just changed'])
  } finally { await board.close() }
})

test('a refusal on the page stays visible after its card is removed by a redraw', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const base = { counts: { waiting: 0, active: 0, due: 0, today: 0 }, groups: [], hidden: [], idle: [], stopped: [], turns: [], recent: [], asks: [] }
    const ask = { key: 'gone-card', task: 'Removed task', project: 'Demo', text: 'Keep it, OK?', kind: 'confirm', answers: [], canTick: false, canHide: true, command: null, reopen: null, link: null, send: 'copy', fp: 'old' }
    let finish
    const pending = new Promise(done => { finish = done })
    const dom = await pageDom(html, { ...base, asks: [ask] }, { post: () => pending })
    dom.buttons().find(button => button.textContent === words.answeredHide).click()
    await dom.flush()
    await dom.redraw(base)
    assert.ok(dom.node('board').firstChild.textContent.includes('Removed task'))
    assert.ok(dom.node('board').firstChild.textContent.includes(words.pressPending) || dom.node('board').firstChild.textContent.includes('…'))
    finish({ ok: false, json: async () => ({ note: 'That line changed' }) })
    await dom.flush(); await dom.flush()
    const card = dom.node('board').firstChild
    assert.ok(card.textContent.includes('Removed task'))
    assert.ok(card.textContent.includes('That line changed'))
    assert.equal(pressWalk(dom.node('board')).filter(node => node.className?.includes('press-result') && node.textContent === 'That line changed').length, 1)
    await dom.redraw({ ...base, counts: { ...base.counts, active: 1 } })
    assert.ok(dom.node('board').firstChild.textContent.includes('That line changed'))
    dom.node('relay').click()
    assert.ok(!dom.node('board').textContent.includes('That line changed'))
  } finally { await board.close() }
})

test('pressing o on the keys board when the page cannot open says why', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-opener-refused-'))
  try {
    const path = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(path, '# Progress\n')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\nprocess.env.SystemRoot = ${JSON.stringify(root)}; process.env.PATH = ${JSON.stringify(root)};\n${BOARD_SCRIPT}`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PATH'].includes(key.toUpperCase())))
    const result = spawnSync(process.execPath, [script, '--keys', 'o'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...env, CLAUDE_PROGRESS_FILE: '', PATH: root, NO_COLOR: '1' } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Could not open the board page: the browser could not be started\./)
    assert.ok(!result.stdout.includes(root))
    assert.ok(result.stdout.replace(/\s+/g, ' ').includes('Open progress.html, next to progress.md, yourself.'))
    assert.ok(existsSync(join(root, 'progress.html')))
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('a failed page write on the keys board names the file without its folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-page-write-refused-'))
  try {
    const path = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const html = join(root, 'progress.html')
    writeFileSync(path, '# Progress\n')
    mkdirSync(html)
    for (const lang of ['en', 'zh-TW', 'zh-CN']) {
      writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
      const result = spawnSync(process.execPath, [script, '--keys', 'o'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
      assert.equal(result.status, 1, result.stderr)
      const words = { en: EN, 'zh-TW': ZH_TW, 'zh-CN': ZH_CN }[lang]
      assert.ok(result.stdout.includes(words.fileNamed('progress.html')), result.stdout)
      assert.ok(!result.stdout.includes(root), result.stdout)
      assert.ok(!result.stderr.includes(root), result.stderr)
      assert.ok(result.stdout.replace(/\s/g, '').includes(result.stderr.replace(/\s/g, '')), result.stdout)
      assert.ok([words.storageIsFolder, words.storageReadOnly].some(reason => result.stderr.trim() === words.boardStorageFailed(words.fileNamed('progress.html'), reason)), result.stderr)
    }
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('a failed page write on the watch board names the file without its folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-watch-page-write-refused-'))
  try {
    const path = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const preload = join(root, 'preload.mjs')
    writeFileSync(path, '# Progress\n')
    mkdirSync(join(root, 'progress.html'))
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    writeFileSync(preload, `Object.defineProperty(process.stdin, 'isTTY', { value: true })
process.stdin.setRawMode = () => {}
const write = process.stdout.write.bind(process.stdout)
let drawn = false
process.stdout.write = function (text, ...rest) {
  const result = write(text, ...rest)
  if (!drawn && String(text).startsWith('\\x1b[2J\\x1b[H')) {
    drawn = true
    queueMicrotask(() => {
      process.stdin.emit('data', 'o')
      process.stdin.emit('data', 'q')
    })
  }
  return result
}
`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--watch'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(result.stdout.includes(EN.fileNamed('progress.html')), result.stdout)
    assert.ok(!result.stdout.includes(root), result.stdout)
    assert.ok(!result.stderr.includes(root), result.stderr)
    assert.ok(result.stdout.replace(/\s/g, '').includes(result.stderr.replace(/\s/g, '')), result.stdout)
    assert.ok([EN.storageIsFolder, EN.storageReadOnly].some(reason => result.stderr.trim() === EN.boardStorageFailed(EN.fileNamed('progress.html'), reason)), result.stderr)
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('in --watch a late browser-open note never shows under another card', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-watch-late-open-'))
  try {
    const path = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const preload = join(root, 'preload.mjs')
    writeFileSync(path, '# Progress\n## Demo\n### Synthetic task\n- [ ] Next step\n- [ ] Later step\n')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    writeFileSync(preload, `import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
Object.defineProperty(process.stdin, 'isTTY', { value: true })
process.stdin.setRawMode = () => {}
let browser
childProcess.spawn = () => { browser = new EventEmitter(); browser.unref = () => {}; return browser }
syncBuiltinESMExports()
const write = process.stdout.write.bind(process.stdout)
let drawn = false
process.stdout.write = function (text, ...rest) {
  const result = write(text, ...rest)
  if (!drawn && String(text).startsWith('\\x1b[2J\\x1b[H')) {
    drawn = true
    queueMicrotask(() => {
      process.stdin.emit('data', 'o')
      process.stdin.emit('data', 'x')
      browser.emit('spawn')
      process.stdin.emit('data', 'q')
    })
  }
  return result
}
`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--watch'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' } })
    assert.equal(result.status, 0, result.stderr)
    const frame = result.stdout.split('\x1b[2J\x1b[H').at(-1)
    assert.ok(frame.includes('Synthetic task'), frame)
    assert.match(frame, /^Opened the board page/m)
    assert.doesNotMatch(frame, /^\s+Opened the board page/m)
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('the local serve page names only the file it cannot read or write', { timeout: 30_000 }, async () => {
  const faults = mkdtempSync(join(tmpdir(), 'board-local-file-only-'))
  const preload = join(faults, 'fault.cjs')
  const flag = join(faults, 'deny-read')
  writeFileSync(preload, `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const read = fs.readFileSync
const rename = fs.renameSync
fs.readFileSync = (path, ...args) => { if (String(path).includes('-journal-') && fs.existsSync(${JSON.stringify(flag)})) throw Object.assign(new Error('synthetic read refusal'), { code: 'EACCES' }); return read(path, ...args) }
fs.renameSync = (from, to) => { if (String(to).includes('-journal-')) throw Object.assign(new Error('synthetic write refusal'), { code: 'EIO' }); return rename(from, to) }
syncBuiltinESMExports()
`)
  const board = await page('', { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  try {
    const before = readFileSync(board.path, 'utf8')
    const now = new Date()
    const journal = `progress-journal-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.md`
    const row = await board.rowOf('Fabrikam fellowship')
    const written = await board.call('POST', '/api/act', { body: { key: row.key, type: 'tick', text: 'Ask two referees', fp: row.fp } })
    assert.equal(written.status, 409, written.body)
    assert.equal(written.json().note, EN.boardStorageFailed(EN.fileNamed(journal), EN.storageUnknown))
    assert.ok(!written.json().note.includes(board.dir), written.body)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    writeFileSync(flag, '')
    const read = await board.call('GET', '/api/board')
    assert.equal(read.status, 409, read.body)
    assert.equal(read.json().note, EN.boardStorageFailed(EN.fileNamed(journal), EN.storageReadOnly))
    assert.ok(!read.json().note.includes(board.dir), read.body)
  } finally {
    await board.close()
    assert.ok(resolve(faults).startsWith(resolve(tmpdir()) + sep))
    rmSync(faults, { recursive: true, force: true })
  }
})

test('a refused browser open names a custom page without its folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-custom-page-'))
  try {
    const path = join(root, 'board.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(path, '# Progress\n')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
    for (const lang of ['en', 'zh-TW', 'zh-CN']) {
      writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\nprocess.env.SystemRoot = ${JSON.stringify(root)}; process.env.PATH = ${JSON.stringify(root)};\n${BOARD_SCRIPT}`)
      const result = spawnSync(process.execPath, [script, '--keys', 'o'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...env, CLAUDE_PROGRESS_FILE: '', PATH: root, NO_COLOR: '1' } })
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.includes('board.html'), result.stdout)
      assert.ok(result.stdout.includes('board.md'), result.stdout)
      assert.ok(!result.stdout.includes('progress.html'), result.stdout)
      assert.ok(!result.stdout.includes(root), result.stdout)
    }
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('a refused press on the page shows its reason in the alert colour next to its card', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const base = { counts: { waiting: 1, active: 0, due: 0, today: 0 }, groups: [], hidden: [], idle: [], stopped: [], turns: [], recent: [] }
    const ask = { key: 'refused-card', task: 'Synthetic task', project: 'Demo', text: 'Keep it, OK?', kind: 'confirm', answers: [], canTick: false, canHide: true, command: null, reopen: null, link: null, send: 'copy', fp: 'before' }
    let finish
    const dom = await pageDom(html, { ...base, asks: [ask] }, { post: () => new Promise(done => { finish = done }) })
    dom.buttons().find(button => button.textContent === words.answeredHide).click()
    assert.equal(pageCardResults(dom, ask.key)[0].textContent, words.pressPending)
    finish({ ok: false, json: async () => ({ note: 'Synthetic refusal' }) })
    await dom.flush(); await dom.flush()
    const [result] = pageCardResults(dom, ask.key)
    assert.equal(result.textContent, 'Synthetic refusal')
    assert.match(result.className, /\balert\b/)
    assert.ok(html.includes('.press-result.alert{color:var(--alert)}'))
    assert.ok(html.includes('.press-result.done{color:var(--done)}'))
    assert.ok(html.includes('.press-result:empty{display:none}'))
    assert.equal(dom.node('note').textContent, '')
  } finally { await board.close() }
})

test('a paste on the page shows its result next to the paste box', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const model = (await board.call('GET', '/api/board')).json().model
    for (const outcome of ['empty', 'merged', 'refused', 'offline', 'gone']) {
      let isReachable = true
      const dom = await pageDom(html, model, { copyAllowed: true, getBoard: async () => {
        if (!isReachable) throw new Error('synthetic offline')
        return { ok: true, json: async () => ({ model, now: 1 }) }
      }, post: async () => {
        if (outcome === 'gone') isReachable = false
        if (outcome === 'offline' || outcome === 'gone') throw new Error('synthetic offline')
        return { ok: outcome === 'merged', json: async () => ({ note: outcome === 'merged' ? 'Synthetic merge saved' : 'Synthetic merge refused' }) }
      } })
      dom.node('note').textContent = 'Stale paste feedback'
      dom.node('paste').value = outcome === 'empty' ? '  ' : 'Synthetic report'
      dom.node('paste-go').click()
      if (outcome !== 'empty') assert.equal(dom.node('.paste').childNodes.find(node => node.className?.includes('press-result')).textContent, words.pressPending)
      await dom.flush(); await dom.flush()
      // Read the board again at once so the offline advice becomes the plain failure.
      if (outcome === 'offline') await dom.redraw(model)
      const expected = outcome === 'empty' ? words.pressEmpty : outcome === 'gone' ? words.serveOffline : outcome === 'offline' ? words.pressFailed : outcome === 'merged' ? 'Synthetic merge saved' : 'Synthetic merge refused'
      const slots = dom.node('.paste').childNodes.filter(node => node.className?.includes('press-result'))
      assert.equal(slots.length, 1)
      assert.equal(slots[0].textContent, expected)
      assert.match(slots[0].className, outcome === 'merged' ? /\bdone\b/ : /\balert\b/)
      assert.equal(dom.node('note').textContent, '')
      assert.equal(dom.node('paste').value, outcome === 'merged' ? '' : outcome === 'empty' ? '  ' : 'Synthetic report')
      await dom.redraw(model)
      assert.equal(slots[0].textContent, expected)
      dom.node('note').textContent = 'Older global feedback'
      dom.node('relay').click()
      await dom.flush()
      assert.equal(dom.node('note').textContent, '')
      assert.equal(slots[0].textContent, words.copied)
    }
  } finally { await board.close() }
})

test('terminal refusals and storage errors use the alert colour while successes use done', async () => {
  const fixture = await pressRuntime()
  const { runtime } = fixture
  try {
    const cell = PRESS_CELLS.find(cell => cell.kind === 'hand-kept')
    for (const failing of [false, true]) {
      fixture.reset(cell)
      const current = runtime.view()
      const items = runtime.boardItems(current, [])
      const item = items.find(item => item.type === 'ask' && item.ask.task === cell.title)
      const state = { ...runtime.emptyBoardState, key: item.key, selected: items.indexOf(item) }
      const opening = runtime.press(runtime.pinned(state, items), 'o').state
      assert.equal(opening.tone, 'quiet')
      assert.equal(opening.note, runtime.s.pressPending)
      const pending = runtime.boardScreen(current, [], opening, runtime.s, { width: 200, isColor: true })
      assert.ok(pending.includes(`\u001b[2m${runtime.s.pressPending}`))
      assert.ok(!pending.includes(`\u001b[31m${runtime.s.pressPending}`))
      const refusal = runtime.press(runtime.pinned(state, items), 'a').state
      const refused = runtime.boardScreen(current, [], refusal, runtime.s, { width: 200, isColor: true })
      assert.ok(refused.includes(`\u001b[31m${refusal.note}`))
      fixture.enable(failing)
      const pressed = runtime.press(runtime.pinned(state, items), 'x').state
      const shown = runtime.boardScreen(runtime.view(), [], pressed, runtime.s, { width: 1000, isColor: true })
      assert.equal(pressed.tone, failing ? 'alert' : 'done')
      assert.ok(shown.includes(`\u001b[${failing ? '31' : '32'}m${pressed.note}`))
      fixture.disable()
    }
  } finally { fixture.close() }
})

test('relay copy failure stays beside its button after the first refresh', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const model = (await board.call('GET', '/api/board')).json().model
    const dom = await pageDom(html, model)
    dom.node('relay').click()
    await dom.flush()
    const slot = dom.node('.paste').childNodes.find(node => node.className?.includes('press-result'))
    assert.ok(slot)
    assert.equal(slot.childNodes.filter(node => node.tag === 'textarea').length, 1)
    const first = slot.childNodes.find(node => node.tag === 'textarea')
    assert.equal(first.getAttribute('readonly'), '')
    assert.equal(first.isSelected, true)
    await dom.redraw(model)
    const redrawn = dom.node('.paste').childNodes.find(node => node.className?.includes('press-result'))
    const area = redrawn?.childNodes.find(node => node.tag === 'textarea')
    assert.ok(redrawn.textContent)
    assert.ok(area)
    assert.equal(area.getAttribute('readonly'), '')
    assert.equal(area.value, first.value)
  } finally { await board.close() }
})

test('a new page press clears finished copy text and keeps other pending results', async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
    const base = { counts: { waiting: 2, active: 0, due: 0, today: 0 }, groups: [], hidden: [], idle: [], stopped: [], turns: [], recent: [] }
    const asks = ['a', 'b'].map(key => ({ key, task: `Card ${key}`, project: 'Demo', text: `Question ${key}?`, kind: 'confirm', chip: 'Confirm', answers: [], canTick: false, canHide: true, command: `copy-${key}`, reopen: null, link: null, send: 'copy', fp: key }))
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const dom = await pageDom(html, { ...base, asks }, { post: async () => pending })
    const copyA = dom.buttons().find(button => button.textContent === words.serveCopyCommand)
    assert.ok(copyA)
    copyA.click()
    await dom.flush()
    const walk = node => [node, ...node.childNodes.flatMap(walk)]
    assert.ok(walk(dom.node('board')).some(node => node.tag === 'textarea' && node.value === 'copy-a'))
    const hides = dom.buttons().filter(button => button.textContent === words.answeredHide)
    assert.equal(hides.length, 2)
    hides[1].click()
    await dom.flush()
    dom.node('relay').click()
    await dom.flush()
    const shown = walk(dom.node('board'))
    assert.ok(!shown.some(node => node.tag === 'textarea' && node.value === 'copy-a'))
    assert.ok(shown.some(node => node.className?.includes('press-result') && node.textContent !== ''))
    finish({ ok: true, json: async () => ({ note: 'Hidden.' }) })
    await dom.flush()
  } finally { await board.close() }
})

test('the terminal board prints one final result for repeated empty actions and quit', () => {
  const shown = run('en', ['--keys', 'x u q'])
  assert.equal(shown.match(/There is nothing to change here\./g)?.length, 1)
  assert.doesNotMatch(shown, /Action completed\./)
  assert.equal(run('en', ['--keys', 'q']).includes('Action completed.'), false)
})

test('the phone page explains how to open a new address in every language without LAN access', async () => {
  const lines = {
    en: "Can't reach the board. On the computer, run the board with --serve --lan again and open the new address.",
    'zh-TW': '連不上看板。請在電腦上用 --serve --lan 重新啟動看板，再開啟新的網址。',
    'zh-CN': '连不上看板。请在电脑上用 --serve --lan 重新启动看板，再打开新地址。',
  }
  for (const [lang, line] of Object.entries(lines)) {
    const source = `${BOARD_SCRIPT}\nprocess.stdout.write(servePage(STRINGS[${JSON.stringify(lang)}], 'synthetic', true))\n`
    const html = run(lang, ['--chat'], {}, FILE, source)
    const dom = await pageDom(html, null, { getBoard: async () => { throw new Error('Synthetic connection refused') } })
    await dom.settle()
    assert.equal(dom.node('offline').textContent, line)
  }
})

test('an old page rejected by a restarted server shows the offline line', async () => {
  const source = `${BOARD_SCRIPT}\nprocess.stdout.write(servePage(STRINGS.en, 'synthetic'))\n`
  const html = run('en', ['--chat'], {}, FILE, source)
  const dom = await pageDom(html, null, { getBoard: async () => ({ ok: false, json: async () => ({}) }) })
  await dom.settle()
  assert.equal(dom.node('offline').textContent, JSON.parse(dom.node('words').textContent).serveOffline)
  assert.ok(dom.allButtons().filter(button => button.getAttribute('data-local') === null).every(button => button.disabled))
})

test('every press on a page whose server restarted with a new key shows the offline line at once', async () => {
  const board = await page()
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    for (const action of ['close', 'tick', 'paste', 'tidy']) {
      let isRestarted = false
      let refreshes = 0
      const rejected = () => ({ ok: false, json: async () => ({}) })
      const dom = await pageDom(html, model, {
        getBoard: async () => {
          if (isRestarted) { refreshes += 1; return rejected() }
          return { ok: true, json: async () => ({ model, now: 1 }) }
        },
        post: async () => { isRestarted = true; return rejected() },
      })
      await dom.settle()
      const words = JSON.parse(dom.node('words').textContent)
      assert.equal(dom.node('offline').textContent, '', action)
      dom.node('paste').value = '## Synthetic\n### Rejected paste\n- [ ] Keep this draft\n'
      const button = action === 'close' ? dom.node('close') : action === 'paste' ? dom.node('paste-go') : dom.allButtons().find(button => action === 'tidy' ? button.textContent === words.archiveNow : button.textContent.includes('Ask two referees'))
      assert.ok(button && !button.disabled, action)
      button.click()
      await dom.settle()
      assert.equal(dom.node('offline').textContent, words.serveOffline, action)
      assert.notEqual(dom.node('note').textContent, '…', action)
      assert.equal(dom.requests.length, 1, action)
      assert.equal(refreshes, 1, `${action}: refreshes without waiting for a poll`)
      assert.ok(dom.allButtons().filter(button => button.getAttribute('data-local') === null).every(button => button.disabled), action)
    }
  } finally { await board.close() }
})

test('the page helper flush leaves a pending press available to resolve', async () => {
  const source = `${BOARD_SCRIPT}\nprocess.stdout.write(servePage(STRINGS.en, 'synthetic'))\n`
  const html = run('en', ['--chat'], {}, FILE, source)
  const model = { counts: { waiting: 0, active: 0, due: 0, today: 0 }, asks: [], hidden: [], idle: [], stopped: [], groups: [], turns: [], recent: [] }
  let finish
  const pending = new Promise(done => { finish = done })
  const dom = await pageDom(html, model, { post: async () => pending })
  dom.node('paste').value = '## Synthetic\n### Pending paste\n- [ ] Wait\n'
  dom.node('paste-go').click()
  await dom.flush()
  assert.equal(dom.requests.length, 1)
  const slot = () => dom.node('.paste').childNodes.find(node => node.className?.includes('press-result')).textContent
  const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
  assert.equal(slot(), words.pressPending)
  finish({ ok: true, json: async () => ({ note: 'Synthetic finished' }) })
  await dom.settle()
  // The paste result shows beside the paste box (#211).
  assert.equal(slot(), 'Synthetic finished')
})

test('L5 restarted server: an old page tab disables its buttons and says how to reconnect', { timeout: 30_000 }, async () => {
  const lines = {
    en: "Can't reach the board. Run the board with --serve again; it opens a new page, and you can close this one.",
    'zh-TW': '連不上看板。請用 --serve 重新啟動看板；新的頁面會自動開啟，這個分頁可以關閉。',
    'zh-CN': '连不上看板。请用 --serve 重新启动看板；新页面会自动打开，这个标签页可以关闭。',
  }
  const phoneLines = {
    en: "Can't reach the board. On the computer, run the board with --serve --lan again and open the new address.",
    'zh-TW': '連不上看板。請在電腦上用 --serve --lan 重新啟動看板，再開啟新的網址。',
    'zh-CN': '连不上看板。请在电脑上用 --serve --lan 重新启动看板，再打开新地址。',
  }
  for (const [lang, line] of Object.entries(lines)) {
    const board = await page('', {}, ['--lang', lang])
    try {
      // Each offline surface gets its own connected DOM before the same server stops.
      // Reusing that server keeps native permission setup out of the per-surface loop.
      const cases = []
      for (const failure of lang === 'en' ? ['poll', 'paste', 'close', 'tick', 'tidy'] : ['poll']) {
        const model = (await board.call('GET', '/api/board')).json().model
        const html = (await board.call('GET', `/?t=${board.token}`)).body
        const response = reply => ({ ok: reply.status === 200, json: async () => reply.json() })
        const dom = await pageDom(html, model, {
          getBoard: async () => response(await board.call('GET', '/api/board')),
          post: async request => response(await board.call('POST', request.path, { body: request.body })),
        })
        await dom.settle()
        let phone
        if (failure === 'poll') {
          const opened = await board.call('POST', '/api/lan', { body: {} })
          if (opened.status === 200) {
            const url = new URL(opened.json().url)
            const home = await fetchAt(url.hostname, Number(url.port), 'GET', url.pathname + url.search)
            phone = await pageDom(home.body, model, { getBoard: async () => response(await board.call('GET', '/api/board')) })
            await phone.settle()
          }
        }
        assert.ok(dom.allButtons().length > 3)
        cases.push({ failure, dom, model, html, phone })
      }
      await board.call('POST', '/api/close', { body: {} })
      await board.exited
      for (const { failure, dom, model, html, phone } of cases) {
        if (failure === 'poll') {
          await dom.redraw(model)
          await dom.settle()
        } else if (failure === 'paste') {
          dom.node('paste').value = '## Synthetic\n### Offline paste\n- [ ] Keep this draft\n'
          dom.node('paste-go').click()
          await dom.settle()
        } else {
          const words = JSON.parse(dom.node('words').textContent)
          const button = failure === 'close' ? dom.node('close') : dom.allButtons().find(button => failure === 'tidy' ? button.textContent === words.archiveNow : button.textContent.includes('Ask two referees'))
          assert.ok(button, failure)
          button.click()
          await dom.settle()
        }
        assert.ok(dom.allButtons().filter(button => button.getAttribute('data-local') === null).every(button => button.disabled), `${lang}: ${failure}`)
        assert.ok(dom.allButtons().filter(button => button.getAttribute('data-local') !== null).every(button => !button.disabled))
        assert.equal(dom.node('offline').textContent, line)
        assert.match(html, /#offline\{[^}]*position:sticky;top:0;background:var\(--ground\)/)
        assert.match(html, /#offline\{[^}]*padding:8px 0;border-bottom:1px solid var\(--line\)/)
        if (phone) {
          await phone.redraw(model)
          await phone.settle()
          assert.equal(phone.node('offline').textContent, phoneLines[lang])
        }
        if (failure === 'tick' || failure === 'tidy') assert.notEqual(dom.node('note').textContent, '…')
        const writes = dom.node('offline').textWrites
        const requests = dom.requests.length
        for (const button of dom.allButtons().filter(button => button.getAttribute('data-local') === null)) {
          button.click()
          button.events.click?.()
        }
        await dom.redraw(model)
        await dom.settle()
        assert.equal(dom.node('offline').textWrites, writes, 'repeated failures do not announce the same notice again')
        assert.equal(dom.requests.length, requests, 'offline presses send and queue nothing')
        assert.equal(dom.node('offline').textContent, line)
        assert.ok(!existsSync(join(board.dir, 'grok-ran.json')))
      }
    } finally { await board.close() }
  }
})

test('a page that reaches its server again enables its buttons and clears the line', { timeout: 30_000 }, async () => {
  const board = await page(LIVE_QUESTION)
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    model.asks[0].send = 'send'
    model.asks[0].isSending = true
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    let isReachable = true
    const dom = await pageDom(html, model, { getBoard: async () => {
      if (!isReachable) throw new Error('Synthetic connection refused')
      return { ok: true, json: async () => ({ model, now: 1 }) }
    } })
    const enabled = dom.allButtons().filter(button => !button.disabled).map(button => button.textContent)
    const draft = 'Keep my unsent reply'
    dom.boxes()[0].value = draft
    isReachable = false
    await dom.redraw(model)
    await dom.settle()
    assert.ok(dom.allButtons().filter(button => button.getAttribute('data-local') === null).every(button => button.disabled))
    for (const button of dom.allButtons().filter(button => button.getAttribute('data-local') === null)) button.click()
    isReachable = true
    await dom.redraw(model)
    await dom.settle()
    assert.equal(dom.node('offline').textContent, '')
    assert.deepEqual(dom.allButtons().filter(button => !button.disabled).map(button => button.textContent), enabled)
    assert.equal(dom.boxes()[0].value, draft)
    assert.deepEqual(dom.requests, [], 'recovery never replays offline presses')
  } finally { await board.close() }
})

test('an old page tab keeps its copy buttons working while the board is unreachable', async () => {
  const board = await page(LIVE_QUESTION)
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    const ask = model.asks[0]
    ask.send = 'copy'
    ask.command = 'synthetic command'
    ask.reopen = 'synthetic resume'
    model.stopped[0].resume = 'synthetic row resume'
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    let isReachable = true
    const dom = await pageDom(html, model, { clipboard: true, getBoard: async () => {
      if (!isReachable) throw new Error('Synthetic connection refused')
      return { ok: true, json: async () => ({ model, now: 1 }) }
    } })
    dom.boxes()[0].value = 'Synthetic copied reply'
    isReachable = false
    await dom.redraw(model)
    await dom.settle()
    const local = dom.allButtons().filter(button => button.getAttribute('data-local') !== null)
    assert.ok(local.length >= 6, 'reply, answers, command, both resume buttons and relay are local')
    assert.ok(local.every(button => !button.disabled), 'copy buttons enabled')
    assert.ok(dom.allButtons().filter(button => !local.includes(button)).every(button => button.disabled), 'server buttons disabled')
    for (const button of local) button.click()
    await dom.settle()
    for (const text of ['Synthetic copied reply', 'synthetic command', 'synthetic resume', 'synthetic row resume', ...ask.answers]) assert.ok(dom.copied.includes(text), text)
    assert.ok(dom.copied.some(text => text.includes('<!-- auto')))
    assert.deepEqual(dom.requests, [])
  } finally { await board.close() }
})

test('a press that finds the board gone keeps the typed reply', async () => {
  const board = await page(LIVE_QUESTION)
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    for (const mode of ['send', 'connected']) {
      model.asks[0].send = mode
      model.asks[0].delivery = { id: 'synthetic-connection', turn: 'synthetic-turn', agent: 'grok' }
      let isReachable = true
      const dom = await pageDom(html, model, {
        getBoard: async () => {
          if (!isReachable) throw new Error('Synthetic connection refused')
          return { ok: true, json: async () => ({ model, now: 1 }) }
        },
        post: async () => { isReachable = false; throw new Error('Synthetic connection refused') },
      })
      const draft = 'Keep this typed reply'
      dom.boxes()[0].value = draft
      dom.send().click()
      await dom.settle()
      assert.equal(dom.boxes()[0].value, draft, mode)
      assert.equal(dom.node('note').textContent, '', mode)
      // The failed press also says so beside its own card, in words the page was given.
      const words = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
      assert.ok(pageCardResults(dom, model.asks[0].key).some(node => node.textContent === (mode === 'connected' ? words.messagesFailed : words.serveOffline)), mode)
      assert.ok(dom.node('offline').textContent.includes('--serve'))
      assert.equal(dom.requests.length, 1)
      isReachable = true
      await dom.redraw(model)
      await dom.settle()
      assert.equal(dom.boxes()[0].value, draft)
      assert.equal(dom.requests.length, 1, 'recovery never replays the failed reply')
      dom.send().click()
      await dom.settle()
      assert.equal(dom.requests.length, 2, 'an explicit retry is allowed')
    }
    for (const ok of [false, true]) {
      model.asks[0].send = 'send'
      const dom = await pageDom(html, model, { post: async () => ({ ok, json: async () => ({ note: 'Synthetic result' }) }) })
      dom.boxes()[0].value = 'Only clear an accepted reply'
      dom.send().click()
      await dom.settle()
      assert.equal(dom.boxes()[0].value, ok ? '' : 'Only clear an accepted reply')
    }
  } finally { await board.close() }
})

test('a reachable file error replaces the offline line and restores the previous button states', async () => {
  const board = await page(LIVE_QUESTION)
  try {
    const model = (await board.call('GET', '/api/board')).json().model
    model.asks[0].send = 'send'
    model.asks[0].isSending = true
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    let state = 'ok'
    const dom = await pageDom(html, model, { getBoard: async () => {
      if (state === 'offline') throw new Error('Synthetic connection refused')
      return { ok: state === 'ok', json: async () => state === 'ok' ? { model, now: 1 } : { note: 'Synthetic file error (EACCES)' } }
    } })
    const enabled = dom.allButtons().filter(button => !button.disabled).map(button => button.textContent)
    state = 'offline'
    await dom.redraw(model)
    await dom.settle()
    state = 'error'
    await dom.redraw(model)
    await dom.settle()
    assert.equal(dom.node('offline').textContent, '')
    assert.equal(dom.node('note').textContent, 'Synthetic file error (EACCES)')
    assert.deepEqual(dom.allButtons().filter(button => !button.disabled).map(button => button.textContent), enabled)
  } finally { await board.close() }
})

test('the page keeps actionable progress delays without connection inventory or native identifiers', async () => {
  const model = { counts: { waiting: 0, active: 0, due: 0, today: 0 }, asks: [], hidden: [], idle: [], stopped: [], groups: [], turns: [], recent: [] }
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const board = await page('', {}, ['--lang', lang])
    try {
      const html = (await board.call('GET', `/?t=${board.token}`)).body
      const s = JSON.parse(html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1])
      const sessions = [
        { agent: 'codex', status: 'connected', progress: false, receiving: true, session: 'private-native-session', surface: 'Private transport' },
        { agent: 'antigravity', status: 'waiting', progress: false, receiving: true, session: 'private-native-session' },
        { agent: 'opencode', status: 'timed_out', progress: true, receiving: false, session: 'private-native-session' },
      ]
      const dom = await pageDom(html, model, { messaging: { sessions } })
      const shown = dom.node('main').textContent
      assert.ok(shown.includes(s.sessionsWaiting), shown)
      assert.ok(shown.includes(s.sessionsTimedOut), shown)
      assert.match(shown, /antigravity/)
      assert.doesNotMatch(shown, /codex|receiv|收訊|接收|連線|连接|private-native-session|Private transport/i)
      sessions.splice(0)
      await dom.redraw(model)
      assert.equal(dom.node('main').textContent, '')
      const id = 'AB-11111111-2222-4333-8444-555555555555'
      for (const [reply, expected] of [
        ['ACK ' + id, ''],
        ['ACK ' + id + '  \n  ', ''],
        ['ACK ' + id + '  Review ready.  ', 'Review ready.'],
        ['ACK ' + id + '\n  Review ready.\nKeep both lines.  ', 'Review ready.\nKeep both lines.'],
        ['ACK ' + id + '\r\nreal reply', 'real reply'],
        ['ACKNOWLEDGED x', 'ACKNOWLEDGED x'],
        ['ACK ' + id + 'x', 'ACK ' + id + 'x'],
        ['Review ready.', 'Review ready.'],
      ]) {
        const receipt = { id, status: 'acknowledged', reply, error: '' }
        await dom.redraw({
          ...model,
          asks: [{ key: 'question', project: 'Synthetic', agent: 'codex', text: 'Review the route?', answers: [], canTick: true, receipt }],
          stopped: [{ key: 'task', title: 'Review the route', status: '', steps: [], receipt }],
        })
        const lines = []
        const collect = node => {
          if (node.tag === 'p' && node.textContent.startsWith(s.messagesAcknowledged)) lines.push(node.textContent)
          node.childNodes.forEach(collect)
        }
        collect(dom.node('board'))
        assert.deepEqual(lines, Array(2).fill(s.messagesAcknowledged + (expected ? ' · ' + expected : '')))
        if (!expected.includes(id)) assert.ok(!dom.node('board').textContent.includes(id), dom.node('board').textContent)
        if (reply.startsWith('ACK ' + id) && !expected.startsWith('ACK ')) assert.ok(!dom.node('board').textContent.includes('ACK'), dom.node('board').textContent)
        assert.equal(receipt.reply, reply)
      }
    } finally { await board.close() }
  }
})

test('the relay page compares unknown-clock reports before retrying and keeps a declined paste', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    const html = (await board.call('GET', `/?t=${board.token}`)).body
    const model = (await board.call('GET', '/api/board')).json().model
    for (const accepts of [false, true]) {
      const comparisons = []
      const dom = await pageDom(html, model, {
        confirm: message => { comparisons.push(message); return accepts },
        post: async request => ({
          ok: Boolean(request.body.reviewToken),
          json: async () => request.body.reviewToken ? { note: 'Imported.' } : { note: 'Unknown clock.', review: { token: 'pair-token', current: 'Old draft', incoming: 'New draft' } },
        }),
      })
      dom.node('paste').value = 'selected report'
      dom.node('paste-go').click()
      await dom.flush()
      assert.equal(comparisons.length, 1)
      assert.match(comparisons[0], /On the board:\nOld draft/)
      assert.match(comparisons[0], /Incoming report:\nNew draft/)
      assert.equal(dom.requests.length, accepts ? 2 : 1)
      if (accepts) assert.deepEqual(JSON.parse(JSON.stringify(dom.requests[1].body)), { text: 'selected report', reviewToken: 'pair-token' })
      assert.equal(dom.node('paste').value, accepts ? '' : 'selected report')
    }
  } finally { await board.close() }
})

test('a reply typed for one session is dropped when the box is redrawn for another session under the same title, and a new reply goes to the session shown', { timeout: 30_000 }, async () => {
  const board = await page('', {}, ['--allow-resume'])
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
    assert.deepEqual([dom.requests[0].path, dom.requests[0].body.session, dom.requests[0].body.fp], ['/api/act', 'd4e5f6a7', second.stopped.find(one => one.title === 'Pick the cache').fp])
    const sent = await call('POST', '/api/act', { body: dom.requests[0].body })
    assert.equal(sent.status, 202, sent.body)
    // The agent stand-in answers after a second; the page is not closed while it is on its way.
    for (let tries = 0; tries < 50 && (await call('GET', '/api/board')).json().replies.length === 0; tries++) await new Promise(done => setTimeout(done, 200))
    assert.equal(JSON.parse(readFileSync(join(board.dir, 'grok-ran.json'), 'utf8')).args[1], '22222222-2222-2222-2222-222222222222')
  } finally {
    await board.close()
  }
})

test('--serve --quiet-board prints only the page address lines', { timeout: 40_000 }, async () => {
  const board = serveIn()
  let url = null
  try {
    // A board larger than the host's output cap must not precede the address.
    writeFileSync(board.path, '## Synthetic project\n' + '### Synthetic large task\n- [ ] Work\n'.repeat(5000))
    const first = await board.serve(['--quiet-board', '--idle-minutes', '10'])
    url = board.urlOf(first)
    assert.ok(url, first)
    const address = `The board you can click (tick, archive, answer): ${url}`
    assert.equal(first.trim(), address)
    const again = await board.serve(['--quiet-board', '--idle-minutes', '20'])
    assert.deepEqual(again.trim().split('\n'), [
      'This board is configured to close after 10 minutes unused. Reopen with --serve.',
      address,
    ])
    writeFileSync(board.path, FILE)
    const ordinary = await board.serve()
    assert.ok(ordinary.startsWith('Progress'), ordinary.slice(0, 200))
    assert.ok(ordinary.includes('Rate-limit the public endpoints'))
  } finally { await board.end([url]) }
})

test('--serve starts the page in the background once, and the next --serve brings back the same page', { timeout: 40_000 }, async () => {
  // serveIn's end waits for the page's process to exit: Windows keeps the fixture folder busy
  // until then, after the address file is gone.
  const board = serveIn()
  let url = null
  try {
    const first = await board.serve()
    url = board.urlOf(first)
    assert.ok(url, first)
    assert.ok(first.startsWith('Progress  ● 1 waiting'), first)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
    const again = await board.serve()
    assert.ok(again.includes(url), again)
  } finally { await board.end([url]) }
})

test('/progress looks for the board script beside a Windows or a POSIX progress path', () => {
  assert.equal(liveBoardScript('C:\\Users\\me\\.claude\\progress.md'), 'C:\\Users\\me\\.claude\\agent-board.mjs')
  assert.equal(liveBoardScript('C:\\Users\\me\\board $sample.md'), 'C:\\Users\\me\\agent-board.mjs')
  assert.equal(liveBoardScript('/home/me/.claude/progress.md'), '/home/me/.claude/agent-board.mjs')
  assert.equal(liveBoardScript('C:/Users/me/.agent-board/progress.md'), 'C:/Users/me/.agent-board/agent-board.mjs')
})

// A synthetic board for --serve runs, with its own folder for running programs.
const serveIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-'))
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  if (process.platform === 'win32') mkdirSync(join(run, 'agent-board'))
  const path = join(dir, 'progress.md')
  writeFileSync(path, FILE)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  // Only what Node needs to run on this computer; the home, settings and temp folders are the
  // fixture's own, so a page started here never reads this account's agents or files.
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
  }
  const serve = (extra = []) =>
    new Promise((done, fail) => execFile(process.execPath, [script, '--serve', '--no-open', ...extra], { env, encoding: 'utf8', timeout: 20_000 }, (error, out) => (error ? fail(error) : done(out))))
  const urlOf = out => out.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1] ?? null
  const served = servedAt(run, path)
  // Closes every page it was given, and the one its address file names when a test could not read
  // the address, and waits for each to take its address file away.
  const end = async urls => {
    const record = existsSync(served) ? JSON.parse(readFileSync(served, 'utf8')) : null
    const pid = record?.pid ?? null
    for (const url of new Set([...urls, record?.url].filter(Boolean))) {
      const { port, searchParams } = new URL(url)
      await new Promise(done => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/close', headers: { host: `127.0.0.1:${port}`, 'x-board-token': searchParams.get('t'), 'content-type': 'application/json' } }, res => res.resume().on('end', done))
        req.on('error', done)
        req.end('{}')
      })
    }
    for (let tries = 0; existsSync(served) && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
    // Windows can still hold the process's working folder after its address file is
    // removed. Wait for that owned server to exit before deleting the fixture.
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    if (typeof pid === 'number' && pid !== process.pid) {
      for (let tries = 0; alive() && tries < 50; tries++) await new Promise(done => setTimeout(done, 100))
      assert.ok(!alive(), 'the fixture server must exit before cleanup')
    }
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return { dir, path, script, env, serve, urlOf, served, end }
}

test('Windows page address tokens stay in a current-account-only runtime folder', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 40_000 }, async () => {
  const board = serveIn()
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const account = execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const sid = /"(S-\d+(?:-\d+)+)"\s*$/.exec(account)?.[1]
    assert.ok(sid)
    const acl = windowsAcl(resolve(board.served, '..'), board.env)
    assert.equal(acl.AreAccessRulesProtected, true, 'the token folder must not inherit shared temp permissions')
    const aces = [...acl.Sddl.matchAll(/\(([^()]*)\)/g)].map(match => match[1].split(';'))
    assert.equal(aces.length, 1)
    assert.equal(aces[0][0], 'A')
    assert.equal(aces[0][2], 'FA')
    assert.deepEqual(acl.Sids, [sid])
    assert.ok(!aces[0][1].includes('ID'), 'the one account grant is explicit')
  } finally { await board.end([url]) }
})

test('Windows trusted address fixtures replace unrelated explicit grants', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 30_000 }, async () => {
  const board = serveIn()
  try {
    writeFileSync(board.served, 'synthetic')
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    execFileSync(join(system, 'icacls.exe'), [board.served, '/grant:r', '*S-1-1-0:F', '/L'], { windowsHide: true, stdio: 'pipe' })
    addressFixture(board.served, 'trusted fixture')
    const acl = windowsAcl(board.served, board.env)
    assert.equal(acl.OwnerSid, acl.CurrentSid)
    assert.deepEqual(acl.Sids, [acl.CurrentSid])
    assert.equal(acl.AreAccessRulesProtected, true)
  } finally { await fs.promises.rm(board.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('runtime ACL validation rejects other owners, other accounts, inherited folders and incomplete grants', () => {
  const sid = 'S-1-5-21-100-200-300-1001'
  const own = `O:${sid}G:SYD:P(A;OICI;FA;;;${sid})`
  assert.equal(isPrivateRuntimeSddl(own, sid, true), true)
  assert.equal(isPrivateRuntimeSddl(`O:${sid}G:SYD:AI(A;ID;FA;;;${sid})`, sid, false), true)
  assert.equal(isPrivateRuntimeSddl(`O:${sid}G:SYD:P(A;;FA;;;${sid})`, sid, false), true)
  for (const changed of [
    own.replace(`O:${sid}`, 'O:SY'), own.replace('D:P', 'D:AI'),
    own.replace(';OICI;', ';OICIID;'), own.replace(';OICI;', ';OI;'), own.replace(';FA;', ';FR;'),
    `${own}(A;OICI;FA;;;WD)`, `${own}(D;OICI;FR;;;WD)`, own.replace(`;;;${sid}`, ';;;SY'),
    `O:${sid}G:SYD:NO_ACCESS_CONTROL`, `O:${sid}G:SYD:P`,
  ]) assert.equal(isPrivateRuntimeSddl(changed, sid, true), false, changed)
  assert.equal(isPrivateRuntimeSddl('O:LAG:SYD:P(A;OICI;FA;;;LA)', 'S-1-5-21-100-200-300-500', true, { LA: 'S-1-5-21-100-200-300-500' }), true)
  assert.equal(isPrivateRuntimeSddl('O:LAG:SYD:P(A;OICI;FA;;;LA)', sid, true, { LA: 'S-1-5-21-100-200-300-500' }), false)
})

test('Windows page ACL setup failure prints one bounded line and writes no token', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 30_000 }, async () => {
  const board = serveIn()
  const preload = join(board.dir, 'acl-denied.cjs')
  writeFileSync(preload, `const cp = require('node:child_process'); const original = cp.execFileSync
cp.execFileSync = (file, ...args) => { if (/icacls\\.exe$/i.test(String(file))) throw Object.assign(new Error('synthetic ACL denial'), { code: 'EACCES' }); return original(file, ...args) }
require('node:module').syncBuiltinESMExports()
`)
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  try {
    for (const mode of ['--serve', '--serve-child']) {
      const ran = spawnSync(process.execPath, [board.script, mode, '--no-open', '--quiet-board'], { env: board.env, encoding: 'utf8', timeout: 20_000 })
      assert.equal(ran.status, 1, ran.stderr)
      assert.equal(mode === '--serve-child' ? ran.stderr.trim() : ran.stdout.trim(), EN.serveRuntimePrivate)
      assert.equal(mode === '--serve-child' ? ran.stdout : ran.stderr, '')
      assert.ok(!(ran.stdout + ran.stderr).includes(board.dir) && !(ran.stdout + ran.stderr).includes('http:'))
      assert.ok(!existsSync(board.served))
      assert.deepEqual(readdirSync(join(board.env.XDG_RUNTIME_DIR, 'agent-board')), [])
    }
  } finally { await board.end([]) }
})

test('Windows page startup refuses a runtime junction without changing its destination', { skip: process.platform !== 'win32' && 'Windows junctions only', timeout: 30_000 }, async () => {
  for (const level of ['folder', 'parent']) {
    const board = serveIn()
    const other = join(board.dir, 'synthetic-other-folder')
    mkdirSync(other)
    const sentinel = join(other, 'keep.txt')
    writeFileSync(sentinel, 'Synthetic file must stay unchanged')
    const target = level === 'parent' ? board.env.XDG_RUNTIME_DIR : join(board.env.XDG_RUNTIME_DIR, 'agent-board')
    renameSync(target, join(board.dir, 'unused-runtime'))
    fs.symlinkSync(other, target, 'junction')
    try {
      const ran = spawnSync(process.execPath, [board.script, '--serve', '--no-open', '--quiet-board'], { env: board.env, encoding: 'utf8', timeout: 20_000 })
      assert.equal(ran.status, 1, ran.stderr)
      assert.equal(ran.stdout.trim(), EN.serveRuntimePrivate)
      assert.equal(readFileSync(sentinel, 'utf8'), 'Synthetic file must stay unchanged')
      assert.deepEqual(readdirSync(other), ['keep.txt'])
    } finally { await board.end([]) }
  }
})

test('Windows page startup refuses an existing address file granted to another account', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 50_000 }, async () => {
  const board = serveIn()
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    execFileSync(icacls, [board.served, '/grant', '*S-1-1-0:R', '/L'], { windowsHide: true, stdio: 'pipe' })
    const again = await board.serve(['--quiet-board'])
    assert.ok(!again.includes(url), 'the widened address must not be used to contact or open the running page')
    assert.equal(again.trim(), EN.serveFailed(EN.serveNotStarted))
  } finally {
    if (existsSync(board.served)) execFileSync(icacls, [board.served, '/remove', '*S-1-1-0', '/L'], { windowsHide: true, stdio: 'pipe' })
    await board.end([url])
  }
})

test('Windows page startup moves a verified private legacy address once and reuses its page', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 50_000 }, async () => {
  const board = serveIn()
  const legacy = join(board.env.XDG_RUNTIME_DIR, board.served.split(/[\\/]/).at(-1))
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    renameSync(board.served, legacy)
    assert.ok(!existsSync(board.served))
    assert.equal(board.urlOf(await board.serve(['--quiet-board'])), url)
    assert.ok(!existsSync(legacy), 'a migrated address is no longer in the old runtime root')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
    assert.equal(board.urlOf(await board.serve(['--quiet-board'])), url)
    assert.ok(!existsSync(legacy))
  } finally { await board.end([url]) }
})

test('Windows page startup leaves an untrusted legacy address unread and contacts only its new page', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 40_000 }, async () => {
  const board = serveIn()
  const legacy = join(board.env.XDG_RUNTIME_DIR, board.served.split(/[\\/]/).at(-1))
  let requests = 0
  const fake = (await import('node:http')).createServer((req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(done => fake.listen(0, '127.0.0.1', done))
  const oldUrl = `http://127.0.0.1:${fake.address().port}/?t=synthetic-untrusted-legacy-token`
  const bytes = JSON.stringify({ pid: process.pid, port: fake.address().port, url: oldUrl, path: board.path, built: '' })
  writeFileSync(legacy, bytes)
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [legacy, '/grant', '*S-1-1-0:R', '/L'], { windowsHide: true, stdio: 'pipe' })
  const opened = join(board.dir, 'untrusted-content-was-opened')
  const preload = join(board.dir, 'observe-legacy.cjs')
  writeFileSync(preload, `const fs = require('node:fs'); const open = fs.openSync; const read = fs.readFileSync
const source = ${JSON.stringify(legacy)}; const marker = ${JSON.stringify(opened)}
fs.openSync = (file, ...args) => { if (String(file) === source) fs.writeFileSync(marker, 'opened'); return open(file, ...args) }
fs.readFileSync = (file, ...args) => { if (String(file) === source) fs.writeFileSync(marker, 'read'); return read(file, ...args) }
require('node:module').syncBuiltinESMExports()
`)
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url && url !== oldUrl)
    assert.equal(requests, 0)
    assert.ok(!existsSync(opened), 'the legacy token is not read even when its JSON looks valid')
    assert.equal(readFileSync(legacy, 'utf8'), bytes)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
  } finally { await new Promise(done => fake.close(done)); await board.end([url]) }
})

test('Windows page startup without XDG runtime keeps the token under the isolated home', { skip: process.platform !== 'win32' && 'Windows runtime fallback only', timeout: 30_000 }, async () => {
  const board = await page('', { XDG_RUNTIME_DIR: '' })
  try {
    const file = servedAt(join(process.env.USERPROFILE, '.cache'), board.path)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).url, board.url.href)
    const old = join(tmpdir(), file.split(/[\\/]/).at(-1))
    assert.ok(!existsSync(old), 'the shared temp root gets no address token')
  } finally { await board.close() }
})

test('a private address renamed from another board is never migrated, contacted or closed', { timeout: 120_000 }, async () => {
  for (const location of process.platform === 'win32' ? ['legacy', 'current'] : ['current']) {
    const victim = serveIn()
    const other = serveIn()
    const requests = join(other.dir, 'requests.jsonl')
    const preload = join(other.dir, 'observe-requests.cjs')
    writeFileSync(preload, `const http = require('node:http'); const fs = require('node:fs'); const original = http.createServer
http.createServer = (listener, ...args) => original((req, res) => { fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: req.method, path: req.url }) + '\\n'); return listener(req, res) }, ...args)
require('node:module').syncBuiltinESMExports()
`)
    other.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
    let victimUrl = null, otherUrl = null, otherBytes, replay, original
    try {
      otherUrl = other.urlOf(await other.serve(['--quiet-board']))
      assert.ok(otherUrl)
      // Trusted setup records the owned server. The attacker-mode operation below only moves
      // its directory entry; it does not read or rewrite the private token's contents.
      otherBytes = readFileSync(other.served)
      original = fs.lstatSync(other.served)
      writeFileSync(requests, '')
      replay = location === 'legacy' ? join(victim.env.XDG_RUNTIME_DIR, victim.served.split(/[\\/]/).at(-1)) : victim.served
      renameSync(other.served, replay)
      const renamed = fs.lstatSync(replay)
      assert.deepEqual([renamed.dev, renamed.ino, renamed.size], [original.dev, original.ino, original.size])
      victimUrl = victim.urlOf(await victim.serve(['--quiet-board']))
      assert.deepEqual(readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), [], 'a mismatched record authorizes no request to the other board')
      const pid = JSON.parse(otherBytes.toString('utf8')).pid
      assert.doesNotThrow(() => process.kill(pid, 0), 'the other owned board remains running')
      if (location === 'legacy') {
        assert.ok(victimUrl && victimUrl !== otherUrl)
        assert.deepEqual(readFileSync(replay), otherBytes)
        assert.equal(JSON.parse(readFileSync(victim.served, 'utf8')).path, victim.path)
      } else assert.equal(victimUrl, null, 'an existing mismatched current address fails closed')
    } finally {
      // Restore the owned server's pointer only after the assertions, so its normal cleanup
      // can wait for that exact process rather than relying on a detached child's timing.
      if (replay && existsSync(replay) && original) {
        const held = fs.lstatSync(replay)
        if (held.dev === original.dev && held.ino === original.ino && !existsSync(other.served)) renameSync(replay, other.served)
      }
      if (otherBytes && !existsSync(other.served)) {
        const pid = JSON.parse(otherBytes.toString('utf8')).pid
        let isAlive = false
        try { process.kill(pid, 0); isAlive = true } catch {}
        if (isAlive) addressFixture(other.served, otherBytes)
      }
      await victim.end([victimUrl])
      await other.end([otherUrl])
    }
  }
})

test('Windows page ACL checks use the system module instead of an inherited module path', { skip: process.platform !== 'win32' && 'Windows PowerShell modules only', timeout: 40_000 }, async () => {
  const board = serveIn()
  const modules = join(board.dir, 'untrusted-modules')
  const module = join(modules, 'Microsoft.PowerShell.Security')
  mkdirSync(module, { recursive: true })
  const touched = join(board.dir, 'untrusted-module-loaded')
  writeFileSync(join(module, 'Microsoft.PowerShell.Security.psd1'), "@{ RootModule = 'fake.psm1'; ModuleVersion = '99.0.0'; GUID = '34000000-0000-4000-8000-000000000001'; FunctionsToExport = @('Get-Acl') }")
  writeFileSync(join(module, 'fake.psm1'), `function Get-Acl { Set-Content -LiteralPath '${touched.replaceAll("'", "''")}' -Value 'unexpected'; throw 'synthetic untrusted ACL module' }; Export-ModuleMember -Function Get-Acl`)
  board.env.PSModulePath = modules
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    assert.ok(!existsSync(touched))
    assert.equal(board.env.PSModulePath, modules, 'the caller environment is unchanged')
  } finally { await board.end([url]) }
})

test('Windows page ACL checks work without PowerShell command discovery', { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 40_000 }, async () => {
  const board = serveIn()
  const preload = join(board.dir, 'no-module-discovery.cjs')
  writeFileSync(preload, `const cp = require('node:child_process'); const original = cp.execFileSync
cp.execFileSync = (file, args, options) => {
  if (/powershell\\.exe$/i.test(String(file))) {
    const index = args.indexOf('-Command')
    if (index >= 0) args = args.map((arg, at) => at === index + 1 ? "$PSModuleAutoLoadingPreference = 'None'; " + arg : arg)
  }
  return original(file, args, options)
}
require('node:module').syncBuiltinESMExports()
`)
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).path, board.path)
  } finally { await board.end([url]) }
})

test('Windows page token writes explicitly own a new file before trusting its inherited ACL', { skip: process.platform !== 'win32' && 'Windows token owner only', timeout: 40_000 }, async () => {
  const board = serveIn()
  const preload = join(board.dir, 'default-group-owner.cjs')
  const changed = join(board.dir, 'new-file-owner-set')
  writeFileSync(preload, `const cp = require('node:child_process'); const fs = require('node:fs'); const original = cp.execFileSync
const target = ${JSON.stringify(board.served)}.toLowerCase(); const marker = ${JSON.stringify(changed)}
let owned = false
cp.execFileSync = (file, args, options) => {
  if (/icacls\\.exe$/i.test(String(file)) && String(args[0]).toLowerCase() === target && args.includes('/setowner')) { owned = true; fs.writeFileSync(marker, 'set before read and write') }
  if (/powershell\\.exe$/i.test(String(file)) && String(options?.env?.AGENT_BOARD_RUNTIME_ACL_PATH).toLowerCase() === target && !owned) {
    const account = original(String(file).replace(/WindowsPowerShell[\\\\/]v1\\.0[\\\\/]powershell\\.exe$/i, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const sid = /"(S-\\d+(?:-\\d+)+)"\\s*$/.exec(account)?.[1]
    if (!sid) throw new Error('synthetic account lookup failed')
    fs.writeFileSync(marker + '.group-default', 'modeled group default owner')
    return 'O:BAG:SYD:AI(A;ID;FA;;;' + sid + ')'
  }
  return original(file, args, options)
}
require('node:module').syncBuiltinESMExports()
`)
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    if (!url) assert.ok(existsSync(changed + '.group-default'), 'the failure must come from the modeled group owner')
    assert.ok(url)
    assert.equal(readFileSync(changed, 'utf8'), 'set before read and write')
    assert.ok(!existsSync(changed + '.group-default'), 'ownership is set before an inherited group owner can be trusted')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
  } finally { await board.end([url]) }
})

test('server memory arguments retain explicit heap choices and ignore unrelated Node flags', () => {
  assert.deepEqual(serverMemoryArgs([], ''), ['--optimize-for-size'])
  assert.deepEqual(serverMemoryArgs(['--inspect=0', '--require', '--max-semi-space-size=8'], ''), ['--optimize-for-size'])
  const explicit = ['--inspect=0', '--max_old_space_size', '128', '--heap-growing-percent=30']
  assert.deepEqual(serverMemoryArgs(explicit, '--max-semi-space-size=8'), ['--max_old_space_size', '128', '--heap-growing-percent=30'])
  assert.deepEqual(explicit, ['--inspect=0', '--max_old_space_size', '128', '--heap-growing-percent=30'])
  for (const options of ['--max-semi-space-size=8', '--max_old_space_size 128', '"--max-heap-size=128"', '--max-old-space-size-percentage=25']) assert.deepEqual(serverMemoryArgs([], options), [])
  for (const argument of ['--no-optimize-for-size', '--nooptimize-for-size', '--nooptimize_for_size']) assert.deepEqual(serverMemoryArgs([argument], ''), [argument])
  assert.deepEqual(serverMemoryArgs([], '--require "a path/--max-old-space-size.cjs"'), ['--optimize-for-size'])
})

test('a background page uses its memory policy without changing the account\'s Node options', { timeout: 40_000 }, async () => {
  const board = serveIn()
  const preload = join(board.dir, 'runtime.cjs')
  const received = join(board.dir, 'runtime.json')
  writeFileSync(preload, `if (process.argv.includes('--serve-child')) require('node:fs').writeFileSync(${JSON.stringify(received)}, JSON.stringify({ argv: process.execArgv, options: process.env.NODE_OPTIONS }))\n`)
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let url = null
  try {
    url = board.urlOf(await board.serve(['--quiet-board']))
    assert.ok(url)
    const runtime = JSON.parse(readFileSync(received, 'utf8'))
    assert.deepEqual(runtime.argv, ['--optimize-for-size'])
    assert.equal(runtime.options, board.env.NODE_OPTIONS)
    const response = await fetch(new URL('/api/board', url), { headers: { 'x-board-token': new URL(url).searchParams.get('t') } })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  } finally { await board.end([url]) }
})

test('a background page preserves explicit heap settings from the caller and the environment', { timeout: 60_000 }, async () => {
  for (const variant of [
    { argv: ['--max-semi-space-size=8'], options: '', expected: ['--max-semi-space-size=8'] },
    { argv: [], options: '--max-semi-space-size=8', expected: [] },
    { argv: ['--nooptimize-for-size'], options: '', expected: ['--nooptimize-for-size'] },
  ]) {
    const board = serveIn()
    const preload = join(board.dir, 'runtime.cjs')
    const received = join(board.dir, 'runtime.json')
    writeFileSync(preload, `if (process.argv.includes('--serve-child')) require('node:fs').writeFileSync(${JSON.stringify(received)}, JSON.stringify({ argv: process.execArgv, options: process.env.NODE_OPTIONS }))\n`)
    board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)} ${variant.options}`.trim()
    let url = null
    try {
      const out = await new Promise((done, fail) => execFile(process.execPath, [...variant.argv, board.script, '--serve', '--no-open', '--quiet-board'], { env: board.env, encoding: 'utf8', timeout: 20_000 }, (error, stdout) => error ? fail(error) : done(stdout)))
      url = board.urlOf(out)
      assert.ok(url)
      const runtime = JSON.parse(readFileSync(received, 'utf8'))
      assert.deepEqual(runtime.argv, variant.expected)
      assert.equal(runtime.options, board.env.NODE_OPTIONS)
    } finally { await board.end([url]) }
  }
})

// A port nothing listens on.
const freePort = () =>
  new Promise(done => {
    const server = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

test('--serve with a different idle preference reuses the running page and reports its effective timeout', { timeout: 60_000 }, async () => {
  for (const [initial, next, expected, note] of [
    [[], ['--idle-minutes', '30'], 0, 'The local board stays running.'],
    [['--idle-minutes', '30'], [], 1_800_000, 'close after 30 minutes unused'],
  ]) {
    const board = serveIn()
    const urls = []
    try {
      const first = board.urlOf(await board.serve(initial))
      urls.push(first)
      assert.ok(first)
      const before = readFileSync(board.served, 'utf8')
      const again = await board.serve(next)
      const second = board.urlOf(again)
      urls.push(second)
      assert.equal(second, first, again)
      assert.equal(readFileSync(board.served, 'utf8'), before)
      const url = new URL(first)
      const ping = await fetch(new URL('/api/ping', url), { headers: { 'x-board-token': url.searchParams.get('t') }, signal: AbortSignal.timeout(5000) })
      assert.equal((await ping.json()).idleMs, expected)
      assert.ok(again.includes(note), again)
      // The address stays the last line, and the same idle time asked again prints no note.
      assert.ok(again.trimEnd().split(/\r?\n/).at(-1).includes(first), again)
      const same = await board.serve(initial)
      assert.equal(board.urlOf(same), first, same)
      assert.ok(!/stays running|close after/.test(same), same)
    } finally { await board.end(urls) }
  }
})

test('--serve with an idle time that is not a number starts no page', { timeout: 60_000 }, async () => {
  const board = serveIn()
  try {
    for (const extra of [['--idle-minutes', 'abc'], ['--idle-minutes']]) {
      const ran = spawnSync(process.execPath, [board.script, '--serve', '--no-open', ...extra], { env: board.env, encoding: 'utf8', timeout: 20_000 })
      assert.notEqual(ran.status, 0, extra.join(' '))
      assert.match(ran.stderr, /INVALID_IDLE_MINUTES/)
      assert.ok(!existsSync(board.served), extra.join(' '))
    }
  } finally { await board.end([]) }
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

test('Windows concurrent page startup waits for the winning address to finish publishing', { skip: process.platform !== 'win32' && 'Windows ACLs only', timeout: 60_000 }, async () => {
  const board = serveIn()
  const held = join(board.dir, 'publisher-held')
  const release = join(board.dir, 'publisher-release')
  const lost = join(board.dir, 'publisher-contender-lost')
  const prefix = `import publicationFs340 from 'node:fs'
import publicationCp340 from 'node:child_process'
import { syncBuiltinESMExports as publicationSync340 } from 'node:module'
const publicationOpen340 = publicationFs340.openSync
const publicationClose340 = publicationFs340.closeSync
const publicationWrite340 = publicationFs340.writeFileSync
const publicationRead340 = publicationFs340.readFileSync
const publicationSpawn340 = publicationCp340.spawn
const publicationFds340 = new Map()
let publicationReads340 = 0
publicationCp340.spawn = (command, args, options) => {
  if (process.argv.includes('--serve') && args.includes('--serve-child')) {
    publicationWrite340(${JSON.stringify(lost)}, 'lost')
    return publicationSpawn340(command, ['--input-type=module', '-e', 'process.exit(0)'], options)
  }
  return publicationSpawn340(command, args, options)
}
publicationFs340.openSync = (file, flags, ...rest) => {
  const fd = publicationOpen340(file, flags, ...rest)
  if (file === ${JSON.stringify(board.served)}) publicationFds340.set(fd, flags)
  return fd
}
publicationFs340.closeSync = fd => {
  publicationFds340.delete(fd)
  return publicationClose340(fd)
}
publicationFs340.writeFileSync = (file, data, ...rest) => {
  if (process.env.AGENT_BOARD_TEST_PUBLISH_WAIT === '1' && publicationFds340.get(file) === 'wx') {
    publicationWrite340(${JSON.stringify(held)}, 'waiting')
    const until = performance.now() + 15_000
    while (!publicationFs340.existsSync(${JSON.stringify(release)})) {
      if (performance.now() >= until) throw new Error('FIXTURE_PUBLISH_TIMEOUT')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  return publicationWrite340(file, data, ...rest)
}
publicationFs340.readFileSync = (file, ...rest) => {
  const value = publicationRead340(file, ...rest)
  if (process.argv.includes('--serve') && publicationFds340.get(file) === 'r' && value.length === 0) {
    publicationReads340 += 1
    if (publicationReads340 === 2) {
      const past = new Date(Date.now() - 11_000)
      publicationFs340.utimesSync(${JSON.stringify(board.served)}, past, past)
      publicationWrite340(${JSON.stringify(release)}, 'publish')
    }
  }
  return value
}
publicationSync340()
`
  writeFileSync(board.script, prefix + readFileSync(board.script, 'utf8'))
  const publisher = spawn(process.execPath, [board.script, '--serve-child'], {
    env: { ...board.env, AGENT_BOARD_TEST_PUBLISH_WAIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  publisher.stderr.setEncoding('utf8')
  publisher.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(done => publisher.once('exit', done))
  const published = new Promise((done, fail) => {
    let out = ''
    publisher.stdout.setEncoding('utf8')
    publisher.stdout.on('data', chunk => {
      out += chunk
      if (out.includes('\n')) done(out.split('\n')[0].trim())
    })
    publisher.once('error', fail)
    exited.then(code => fail(new Error(`the publisher exited with ${code}: ${stderr}`)))
  })
  published.catch(() => undefined)
  let url = null
  try {
    for (let tries = 0; !existsSync(held) && tries < 500; tries++) await delay(20)
    assert.ok(existsSync(held), stderr)
    assert.equal(statSync(board.served).size, 0, 'the winner has reserved the address but has not published a token')
    // The ordinary simultaneous-start test covers a real losing child. Here its exit is
    // controlled so permission-command speed cannot choose the publication handshake.
    // Aging the reservation only after contention covers a cutoff crossed mid-launch.
    const out = await board.serve(['--quiet-board'])
    url = await Promise.race([published, delay(5000).then(() => { throw new Error('the winner did not publish') })])
    assert.ok(existsSync(lost), 'the losing child exited before the winner published')
    assert.ok(existsSync(board.served), 'the in-flight winner must keep its reserved address')
    assert.equal(board.urlOf(out), url, out)
    assert.ok(existsSync(release), 'the winner was held until the launcher reread the still-empty address')
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).pid, publisher.pid)
  } finally {
    try {
      writeFileSync(release, 'release')
      await Promise.race([published.catch(() => undefined), delay(5000)])
      await board.end([url])
    } finally {
      if (publisher.exitCode === null) publisher.kill()
      await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('the owned publisher did not exit') })])
    }
  }
})

test("the page's address stays out of progress.md's folder, and a file left by a page that is gone does not keep the next one from starting", { timeout: 60_000 }, async () => {
  const board = serveIn()
  const port = await freePort()
  const gone = { pid: 999999, port, url: `http://127.0.0.1:${port}/?t=gone`, path: board.path, built: '' }
  // Where 0.19.0 kept the address, token and all, and where this copy keeps it.
  const old = join(board.dir, 'progress-serve.json')
  addressFixture(old, JSON.stringify(gone))
  addressFixture(board.served, JSON.stringify(gone))
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
  addressFixture(board.served, '{"pid": 12')
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

// Hold the stand-in until explicit release. Its deadline fails rather than
// manufacturing success while the test is still checking the busy state.
const holdingPage = async signal => {
  const hold = mkdtempSync(join(tmpdir(), 'board-hold-'))
  const stand = join(hold, 'grok-stand-in.mjs')
  const calls = join(hold, 'calls.jsonl')
  const gate = join(hold, 'release')
  writeFileSync(stand, `import { appendFileSync, existsSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
const end = Date.now() + 45000
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.stdout.write('Redis it is.\\n', () => process.exit(0)) }
  if (Date.now() > end) { clearInterval(timer); process.stderr.write('FIXTURE_RELEASE_TIMEOUT\\n'); process.exit(1) }
}, 25)
`)
  const agents = { AGENT_BOARD_GROK: stand, AGENT_BOARD_CODEX: stand }
  const board = await page('', agents, ['--allow-resume'])
  const script = join(board.dir, 'agent-board.mjs')
  const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: join(board.dir, 'run'), ...agents }
  const ran = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [])
  // A condition, not a fixed number of sleeps, advances each phase. The test's existing
  // deadline still bounds a missing signal; cancellation also releases the stand-in below.
  const until = async condition => {
    for (;;) {
      signal.throwIfAborted()
      if (await condition()) return
      await delay(25, undefined, { signal })
    }
  }
  let exit
  board.exited.then(code => { exit = code })
  return {
    board,
    ran,
    started: () => until(() => ran().length > 0),
    // A new copy of the script, as after an update: another build time, so --serve means to replace the page.
    update: () => {
      const { atime, mtimeMs } = statSync(script)
      utimesSync(script, atime, new Date(mtimeMs + 5000))
    },
    serve: () => new Promise((done, fail) => execFile(process.execPath, [script, '--serve', '--no-open', '--allow-resume'], { env, encoding: 'utf8', timeout: 30_000 }, (error, out) => (error ? fail(error) : done(out)))),
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
    release: async () => {
      writeFileSync(gate, 'go')
      await until(async () => (await board.call('GET', '/api/ping')).json().sending === 0)
      const replies = (await board.call('GET', '/api/board')).json().replies
      assert.equal(replies.length, 1)
      assert.equal(replies[0].ok, true, replies[0].note)
      assert.match(replies[0].note, /Redis it is\./)
    },
    exited: async () => {
      await until(() => exit !== undefined)
      assert.equal(exit, 0)
    },
  }
}

test('a newer --serve does not start a second page while the page it would replace is sending a reply, shows that page with a note, and replaces it once the reply is in', { timeout: 60_000 }, async t => {
  const held = await holdingPage(t.signal)
  const { board } = held
  const urls = []
  try {
    const drawn = await board.rowOf('Pick the cache')
    const reply = { key: drawn.key, type: 'send', text: 'Redis', session: 'b2c3d4e5', asked: 'Redis or Memcached?', fp: drawn.fp }
    assert.equal((await board.call('POST', '/api/act', { body: reply })).status, 202)
    await held.started()
    assert.equal((await board.call('GET', '/api/ping')).json().sending, 1)
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
    await held.release()
    const next = await held.serve()
    const url = next.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1]
    assert.ok(url, next)
    urls.push(url)
    assert.notEqual(url, board.url.href)
    assert.ok(!next.includes('already open is kept'), next)
    assert.equal(JSON.parse(readFileSync(board.served, 'utf8')).url, url)
    await held.exited()
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
    addressFixture(board.served, JSON.stringify({ pid, port, url: stale, path: board.path, built: '' }))
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
  addressFixture(board.served, JSON.stringify({ pid: process.pid, port, url: stale, path: board.path, built: '' }))
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
    assert.equal(seen.model.stopped.find(row => row.title === 'Pick the cache')?.send, 'open')
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


const TIDY_NOW = Date.UTC(2026, 9, 17, 12)
const tidyFixture = fn => {
  const dir = mkdtempSync(join(tmpdir(), 'board-tidy-'))
  try {
    const path = join(dir, 'progress.md')
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\nDate.now = () => ${TIDY_NOW}\n${BOARD_SCRIPT}`)
    const command = (args = ['--tidy'], preload = '') => spawnSync(process.execPath, [...(preload ? ['-r', preload] : []), script, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir, CLAUDE_PROGRESS_FILE: path, NO_COLOR: '1' },
    })
    const snapshot = () => Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name))]))
    const block = (session, title, state, hours, step = '- [x] Finished') => `<!-- auto session=${session} agent=codex state=${state}${hours === null ? '' : ` updated=${new Date(TIDY_NOW - hours * 3600000).toISOString()}`} -->\n### ${title}\n${step}\n<!-- /auto session=${session} -->\n`
    fn({ dir, path, command, snapshot, block })
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}

test('--tidy archives done blocks older than 12 hours and stopped ones older than 3 days', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) tidyFixture(f => {
    const removed = [
      f.block('a1b2c301', 'Old done', 'done', 13),
      f.block('a1b2c302', 'Old ended', 'ended', 73, '- [ ] Unfinished'),
      f.block('a1b2c303', 'Old silent', 'working', 73, '- [~] Paused'),
    ]
    const kept = [
      f.block('a1b2c304', 'Fresh done', 'done', 11),
      f.block('a1b2c305', 'Fresh stopped', 'ended', 71, '- [ ] Unfinished'),
      f.block('a1b2c306', 'Active', 'working', 1, '- [~] Working'),
      f.block('a1b2c307', 'Unanswered', 'ended', 100, '- [?] Publish, OK?'),
      f.block('a1b2c308', 'Unknown clock', 'done', null),
      f.block('a1b2c309', 'Future clock', 'done', -24),
      f.block('a1b2c310', 'Incomplete block', 'done', 100).replace('<!-- /auto session=a1b2c310 -->\n', ''),
    ]
    writeFileSync(f.path, `## Synthetic\n${removed.join('\n')}\n${kept.join('\n')}`)
    const help = f.command(['--help', '--lang', lang])
    assert.equal(help.status, 0, help.stderr)
    assert.ok(help.stdout.includes('--tidy'), help.stdout)
    const result = f.command(['--tidy', '--lang', lang])
    assert.equal(result.status, 0, result.stderr)
    const after = readFileSync(f.path, 'utf8')
    for (const text of kept) assert.ok(after.includes(text), text)
    const archive = readdirSync(f.dir).filter(name => name.startsWith('progress-archive-'))
    assert.equal(archive.length, 1)
    const history = readFileSync(join(f.dir, archive[0]), 'utf8')
    for (const title of ['Old done', 'Old ended', 'Old silent']) {
      assert.ok(!after.includes(title), after)
      assert.equal(history.split(`### ${title}`).length - 1, 1, history)
    }
    assert.ok(history.includes('- [ ] Unfinished') && history.includes('- [~] Paused'), history)
    const beforeRetry = f.snapshot()
    assert.equal(f.command().status, 0)
    assert.deepEqual(f.snapshot(), beforeRetry)
  })
})

// The scheduled sweep records no question of its own: a board that is open has seen the file first
// (`--keys ''` does the same), and the sweep then runs beside the files that left.
const askingBoard = () => {
  const at = Date.now()
  const block = (session, title, hours) => `<!-- auto session=${session} agent=codex state=ended updated=${new Date(at - hours * 3600000).toISOString()} -->\n### ${title}\n- [x] Draft\n- [?] Publish ${title}, OK?\n<!-- /auto session=${session} -->\n`

  return `## Synthetic\n${block('a1b2c321', 'Old plan', 100)}${block('a1b2c322', 'Young plan', 50)}`
}
const sweepFiles = dir => ({
  ...questionFiles(dir),
  board: readFileSync(join(dir, 'progress.md'), 'utf8'),
  archive: readdirSync(dir).filter(name => name.startsWith('progress-archive-')).map(name => readFileSync(join(dir, name), 'utf8')).join(''),
})
const archivedCopies = files => Object.entries(files).filter(([name]) => name.startsWith('progress-questions-source-')).map(([, text]) => JSON.parse(text)).filter(copy => copy.disposition === 'archived')

test('--tidy archives a block that asks once its three days are over and its question is kept, and leaves the rest', () => {
  const board = askingBoard()
  // No board has seen the question yet, so nothing keeps it and the block stays.
  const cold = chatRun(['--tidy'], { file: () => board, inspect: sweepFiles })
  assert.equal(cold.status, 0, cold.stderr)
  assert.equal(cold.board, board)
  assert.equal(cold.archive, '')
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  assert.equal(JSON.parse(seed.files['progress-questions.json']).records.length, 2)
  const swept = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles })
  assert.equal(swept.status, 0, swept.stderr)
  assert.equal(swept.stdout, 'Archived 1 task.\n')
  assert.ok(!swept.board.includes('Old plan'), swept.board)
  assert.ok(swept.board.includes('Young plan'), swept.board)
  assert.ok(swept.archive.includes('Publish Old plan, OK?'), swept.archive)
  // Both questions are still in the ledger, and the archived block left a copy of its question beside it.
  const open = JSON.parse(swept.files['progress-questions.json']).records.filter(record => record.isUnresolved).map(record => record.words).sort()
  assert.deepEqual(open, ['Publish Old plan, OK?', 'Publish Young plan, OK?'])
  assert.deepEqual(archivedCopies(swept.files).map(copy => copy.record.words), ['Publish Old plan, OK?'])
  // A second sweep finds nothing more and writes nothing.
  const again = chatRun(['--tidy'], { file: () => swept.board, beside: swept.files, inspect: sweepFiles })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.board, swept.board)
  assert.equal(again.archive, '')
  assert.deepEqual(again.files, swept.files)
})

test('--tidy keeps a block that asks when the copy of its question for the archive cannot be written', () => {
  const board = askingBoard()
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const refused = chatRun(['--tidy'], {
    file: () => board, beside: seed.files, inspect: sweepFiles,
    preload: questionFault(`const open = fs.openSync
fs.openSync = (file, ...rest) => { if (rest[0] === 'wx' && String(file).includes('-questions-source-')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return open(file, ...rest) }`),
  })
  assert.equal(refused.status, 0, refused.stderr)
  assert.equal(refused.board, board)
  assert.equal(refused.archive, '')
  assert.deepEqual(archivedCopies(refused.files), [])
  assert.deepEqual(refused.files, seed.files)
})

const sha = body => createHash('sha256').update(body).digest('hex')
const proofJson = (kind, hash) => `${JSON.stringify({ version: 1, kind, hash })}\n`

test('--tidy keeps a block that asks again in the words of an answered question whose retirement was recorded, and takes it while the answer stands', () => {
  const board = askingBoard()
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const ledger = JSON.parse(seed.files['progress-questions.json'])
  const old = ledger.records.find(record => record.words === 'Publish Old plan, OK?')
  // Answered long ago, as a pane would have recorded it.
  const answered = { ...old, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: Date.now() - 200 * 3600000 }
  const receipt = `${JSON.stringify({ version: 1, disposition: 'resolved', record: answered })}\n`
  const files = {
    ...seed.files,
    'progress-questions.json': `${JSON.stringify({ ...ledger, records: ledger.records.map(record => record.id === old.id ? answered : record) }, null, 2)}\n`,
    [`progress-questions-source-${sha(receipt)}.json`]: receipt,
  }
  // The answer still stands: the block asks what was answered, nothing is new, and the block goes.
  const standing = chatRun(['--tidy'], { file: () => board, beside: files, inspect: sweepFiles })
  assert.equal(standing.status, 0, standing.stderr)
  assert.equal(standing.stdout, 'Archived 1 task.\n')
  assert.ok(!standing.board.includes('Old plan'), standing.board)
  // The answer was retired and the agent asked the same words again before any board ran: that ask is not in the ledger, so the block stays.
  const again = chatRun(['--tidy'], { file: () => board, beside: { ...files, [`progress-questions-retired-${sha(old.id)}.json`]: proofJson('retired', sha(old.id)) }, inspect: sweepFiles })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.board, board)
  assert.equal(again.archive, '')
  assert.deepEqual(archivedCopies(again.files), [])
})

test('the terminal board reads each question copy and proof once, however often it draws', () => {
  const board = askingBoard()
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const files = {
    ...seed.files,
    [`progress-questions-retired-${sha('an old question')}.json`]: proofJson('retired', sha('an old question')),
    [`progress-questions-consumed-${sha('an old acknowledgement')}.json`]: proofJson('consumed', sha('an old acknowledgement')),
  }
  const counted = chatRun(['--keys', 'down up down up down up'], {
    file: () => board, beside: files, inspect: sweepFiles,
    preload: questionFault(`const counts = {}
const readFile = fs.readFileSync
fs.readFileSync = (file, ...rest) => { const name = String(file); if (/-questions-(source|retired|consumed)-/.test(name)) counts[name] = (counts[name] ?? 0) + 1; return readFile(file, ...rest) }
process.on('exit', () => process.stderr.write('READS ' + JSON.stringify(counts) + '\\n'))`),
  })
  assert.equal(counted.status, 0, counted.stderr)
  const counts = Object.values(JSON.parse(/READS (.*)/.exec(counted.stderr)[1]))
  // Two copies of open questions and two proofs, each read when first listed and not again at the draws after.
  assert.equal(counts.length, 4, counted.stderr)
  assert.ok(counts.every(count => count === 1), counted.stderr)
  assert.deepEqual(counted.files, files)
})

test('the page retains the identity of a historical unanswered question on its Older shelf', async () => {
  const board = await page()
  try {
    assert.equal((await board.call('GET', '/api/board')).status, 200)
    const ledgerPath = board.path.replace(/\.md$/, '-questions.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const question = ledger.records.find(record => record.words === 'Redis or Memcached?')
    assert.ok(question)
    assert.notEqual(question.isArchived, true)
    writeFileSync(board.path, '# Progress\n')
    const response = await board.call('GET', '/api/board')
    assert.equal(response.status, 200)
    const retained = response.json().model.older.find(item => item.text === 'Redis or Memcached?')
    assert.ok(retained, 'the historical source must remain recoverable')
    assert.equal(retained.questionId, question.id)
  } finally { await board.close() }
})

test('the page retains the identity of a historical question that remains in the main questions', async () => {
  const board = await page()
  try {
    const source = readFileSync(board.path, 'utf8')
    const working = source.replace(/state=ended updated=\S+/, `state=working updated=${new Date().toISOString()}`)
    assert.notEqual(working, source)
    writeFileSync(board.path, working)
    assert.equal((await board.call('GET', '/api/board')).status, 200)
    const ledger = JSON.parse(readFileSync(board.path.replace(/\.md$/, '-questions.json'), 'utf8'))
    const question = ledger.records.find(record => record.words === 'Redis or Memcached?')
    assert.ok(question)
    assert.notEqual(question.isArchived, true)
    writeFileSync(board.path, '# Progress\n')
    const response = await board.call('GET', '/api/board')
    assert.equal(response.status, 200)
    const retained = response.json().model.asks.find(item => item.text === 'Redis or Memcached?')
    assert.ok(retained, 'the historical source keeps its existing visible placement')
    assert.equal(retained.questionId, question.id)
  } finally { await board.close() }
})

const inboxFilesFixture = (hasWatchFailure = false) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-inbox-files-'))
  const directory = join(root, 'files')
  mkdirSync(directory)
  const watchers = []
  const reader = recentInboxFiles({
    directory, isPersistent: true, accepts: name => name.endsWith('.json'),
    watchFiles: (_directory, changed) => {
      if (hasWatchFailure) throw new Error('synthetic watcher unavailable')
      const watcher = new EventEmitter()
      watcher.close = () => { watcher.isClosed = true; watcher.emit('close') }
      watcher.unref = () => {}
      watcher.changed = name => changed('change', name)
      watchers.push(watcher)
      return watcher
    },
  })
  const add = (name, text, at = 1) => {
    const file = join(directory, name)
    writeFileSync(file, text)
    utimesSync(file, at, at)
    return file
  }
  return { root, directory, reader, watchers, add, end: () => { reader.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('empty inbox polls list membership once and discover reports that appear later', () => {
  const fixture = inboxFilesFixture()
  const originalStat = fs.statSync
  const originalList = fs.readdirSync
  const operations = []
  fs.statSync = (...args) => {
    if (args[0] === fixture.directory) operations.push('stat')
    return originalStat(...args)
  }
  fs.readdirSync = (...args) => {
    if (args[0] === fixture.directory) operations.push('readdir')
    return originalList(...args)
  }
  syncBuiltinESMExports()
  const empty = isFresh => {
    operations.length = 0
    assert.deepEqual(fixture.reader.read(isFresh), [])
    assert.deepEqual(operations, ['readdir'], 'an empty inbox needs only its membership listing')
  }
  try {
    empty(false)
    empty(true)
    fixture.add('one.json', 'first report')
    assert.equal(fixture.reader.read(false)[0].body, 'first report')
    const watcher = fixture.watchers.at(-1)
    fs.unlinkSync(join(fixture.directory, 'one.json'))
    empty(false)
    assert.equal(watcher.isClosed, true)
    renameSync(fixture.directory, join(fixture.root, 'old-files'))
    mkdirSync(fixture.directory)
    fixture.add('one.json', 'returned report')
    assert.equal(fixture.reader.read(false)[0].body, 'returned report')
  } finally {
    fs.statSync = originalStat
    fs.readdirSync = originalList
    syncBuiltinESMExports()
    fixture.end()
  }
})

test('inbox display hints keep the newest thirty reports and notice additions and removals', () => {
  const fixture = inboxFilesFixture()
  try {
    for (let index = 0; index < 35; index++) fixture.add(`${index}.json`, `report ${index}`, index + 1)
    const first = fixture.reader.read(false)
    assert.equal(first.length, 30)
    assert.equal(first[0].body, 'report 34')
    assert.equal(first.at(-1).body, 'report 5')
    fs.unlinkSync(join(fixture.directory, '34.json'))
    assert.equal(fixture.reader.read(false)[0].body, 'report 33')
    fixture.add('new.json', 'a new report', 40)
    assert.equal(fixture.reader.read(false)[0].body, 'a new report')
  } finally { fixture.end() }
})

test('inbox display hints reread changed contents with the same name size and modification time', () => {
  const fixture = inboxFilesFixture()
  try {
    fixture.add('one.json', 'first report')
    assert.equal(fixture.reader.read(false)[0].body, 'first report')
    fixture.add('one.json', 'other report')
    fixture.watchers[0].changed('one.json')
    assert.equal(fixture.reader.read(false)[0].body, 'other report')
    fixture.add('one.json', 'third report')
    fixture.watchers[0].changed(null)
    assert.equal(fixture.reader.read(false)[0].body, 'third report')
  } finally { fixture.end() }
})

test('inbox action reads bypass hints before an event arrives and forget a removed report', () => {
  const fixture = inboxFilesFixture()
  try {
    fixture.add('one.json', 'first report')
    assert.equal(fixture.reader.read(false)[0].body, 'first report')
    fixture.add('one.json', 'other report')
    assert.equal(fixture.reader.read()[0].body, 'other report')
    fs.unlinkSync(join(fixture.directory, 'one.json'))
    assert.deepEqual(fixture.reader.read(false), [])
    fixture.add('one.json', 'third report')
    assert.equal(fixture.reader.read(false)[0].body, 'third report')
  } finally { fixture.end() }
})

test('inbox without a watcher rereads mutable reports even when all file metadata stays fixed', () => {
  const fixture = inboxFilesFixture(true)
  const file = fixture.add('one.json', 'first report')
  const originalStat = fs.statSync
  const unchanged = originalStat(file)
  fs.statSync = (...args) => args[0] === file ? unchanged : originalStat(...args)
  syncBuiltinESMExports()
  try {
    assert.equal(fixture.reader.read(false)[0].body, 'first report')
    fixture.add('one.json', 'other report')
    assert.equal(fixture.reader.read(false)[0].body, 'other report')
  } finally {
    fs.statSync = originalStat
    syncBuiltinESMExports()
    fixture.end()
  }
})

test('inbox watcher failures and directory replacement keep fresh report discovery available', () => {
  for (const hasWatchFailure of [false, true]) {
    const fixture = inboxFilesFixture(hasWatchFailure)
    try {
      fixture.add('one.json', 'first report')
      assert.equal(fixture.reader.read(false)[0].body, 'first report')
      if (!hasWatchFailure) fixture.watchers[0].emit('error', new Error('synthetic watcher failed'))
      fixture.add('one.json', 'other report')
      assert.equal(fixture.reader.read(false)[0].body, 'other report')
      renameSync(fixture.directory, join(fixture.root, 'old-files'))
      mkdirSync(fixture.directory)
      fixture.add('new.json', 'a new directory')
      assert.equal(fixture.reader.read(false)[0].body, 'a new directory')
    } finally { fixture.end() }
  }
})

const questionFilesFixture = (hasWatchFailure = false, onName = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-question-files-'))
  const directory = join(root, 'files')
  mkdirSync(directory)
  const watchers = []
  const reader = immutableQuestionFiles({
    directory, isPersistent: true,
    accepts: name => { onName(name); return /^[a-f0-9]{64}\.question$/.test(name) },
    parse: (text, name) => sha(text) === name.slice(0, 64) ? { text } : null,
    watchFiles: (_directory, changed) => {
      if (hasWatchFailure) throw new Error('synthetic watcher unavailable')
      const watcher = new EventEmitter()
      watcher.close = () => { watcher.isClosed = true; watcher.emit('close') }
      watcher.unref = () => {}
      watcher.changed = name => changed('change', name)
      watchers.push(watcher)
      return watcher
    },
  })
  const add = text => {
    const name = `${sha(text)}.question`
    writeFileSync(join(directory, name), text)
    return name
  }
  return { root, directory, reader, watchers, add, end: () => { reader.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('question companion hints validate new files and forget deleted files before they reappear', () => {
  const fixture = questionFilesFixture()
  try {
    const name = fixture.add('first immutable question')
    const first = fixture.reader.read(false)
    assert.equal(first.length, 1)
    assert.equal(fixture.reader.read(false), first)
    fs.unlinkSync(join(fixture.directory, name))
    assert.deepEqual(fixture.reader.read(false), [])
    fixture.add('first immutable question')
    const returned = fixture.reader.read(false)
    assert.deepEqual(returned, first)
    assert.notEqual(returned[0], first[0])
    fixture.add('second immutable question')
    assert.equal(fixture.reader.read(false).length, 2)
  } finally { fixture.end() }
})

test('question companion polls reuse filename validation until a listed name leaves the directory', () => {
  const checked = []
  const fixture = questionFilesFixture(false, name => checked.push(name))
  try {
    const name = fixture.add('stable filename contract')
    writeFileSync(join(fixture.directory, 'unrelated-file'), '')
    assert.equal(fixture.reader.read(false).length, 1)
    const first = checked.length
    assert.equal(fixture.reader.read(false).length, 1)
    assert.equal(checked.length, first, 'unchanged directory names repeated expensive filename validation')
    fs.unlinkSync(join(fixture.directory, name))
    assert.deepEqual(fixture.reader.read(false), [])
    fixture.add('stable filename contract')
    assert.equal(fixture.reader.read(false).length, 1)
    assert.equal(checked.length, first + 1, 'a name that returns must be checked again')
  } finally { fixture.end() }
})

test('question companion hints reread a changed file even when its size and modification time stay fixed', () => {
  const fixture = questionFilesFixture()
  try {
    const text = 'an immutable question'
    const name = fixture.add(text)
    const file = join(fixture.directory, name)
    const before = statSync(file)
    assert.equal(fixture.reader.read(false).length, 1)
    writeFileSync(file, text.replace('an', 'xx'))
    utimesSync(file, before.atime, before.mtime)
    fixture.watchers[0].changed(name)
    assert.equal(fixture.reader.read(false), null)
    writeFileSync(file, text)
    fixture.watchers[0].changed(null)
    assert.equal(fixture.reader.read(false)[0].text, text)
  } finally { fixture.end() }
})

test('question companion actions check changed metadata before a watcher event arrives', () => {
  const fixture = questionFilesFixture()
  try {
    const name = fixture.add('immutable action evidence')
    assert.equal(fixture.reader.read(false).length, 1)
    writeFileSync(join(fixture.directory, name), 'corrupted before an action')
    assert.equal(fixture.reader.read(), null)
    assert.equal(fixture.reader.read(false), null)
  } finally { fixture.end() }
})

test('question companion watcher errors and unavailable watchers fall back to full metadata checks', () => {
  for (const hasWatchFailure of [false, true]) {
    const fixture = questionFilesFixture(hasWatchFailure)
    try {
      const name = fixture.add('immutable fallback evidence')
      assert.equal(fixture.reader.read(false).length, 1)
      if (!hasWatchFailure) fixture.watchers[0].emit('error', new Error('synthetic watcher failed'))
      writeFileSync(join(fixture.directory, name), 'corrupt fallback evidence')
      assert.equal(fixture.reader.read(false), null)
    } finally { fixture.end() }
  }
})

test('question companion directory replacement reattaches the watcher and discards its old contents', () => {
  const fixture = questionFilesFixture()
  try {
    fixture.add('old directory evidence')
    assert.equal(fixture.reader.read(false).length, 1)
    renameSync(fixture.directory, join(fixture.root, 'old-files'))
    mkdirSync(fixture.directory)
    fixture.add('new directory evidence')
    assert.deepEqual(fixture.reader.read(false), [{ text: 'new directory evidence' }])
    assert.equal(fixture.watchers.length, 2)
    assert.equal(fixture.watchers[0].isClosed, true)
  } finally { fixture.end() }
})

test('a persistent page keeps question metadata work flat as immutable companions accumulate', { timeout: 30_000 }, async t => {
  const board = serveIn()
  const seed = chatRun(['--keys', ''], { file: askingBoard, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  writeFileSync(board.path, seed.board)
  for (const [name, text] of Object.entries(seed.files)) writeFileSync(join(board.dir, name), text)
  const probe = join(board.dir, 'question-io-counts.json')
  const preload = join(board.dir, 'question-io.cjs')
  writeFileSync(preload, questionFault(`if (process.argv.includes('--serve-child')) {
  const counts = { stat: 0, read: 0, list: 0 }
  const family = file => /-questions-(source|retired|consumed)-[a-f0-9]{64}\\.json$/.test(String(file))
  for (const name of ['statSync', 'lstatSync', 'readFileSync']) {
    const original = fs[name]
    fs[name] = (file, ...rest) => { if (family(file)) counts[name === 'readFileSync' ? 'read' : 'stat'] += 1; return original(file, ...rest) }
  }
  const list = fs.readdirSync
  fs.readdirSync = (dir, ...rest) => { if (path.resolve(String(dir)) === __dirname) counts.list += 1; return list(dir, ...rest) }
  const http = require('node:http')
  const emit = http.Server.prototype.emit
  const write = fs.writeFileSync
  let sequence = 0
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request') args[1].once('finish', () => write(${JSON.stringify(probe)}, JSON.stringify({ sequence: ++sequence, counts })))
    return emit.call(this, event, ...args)
  }
}`))
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  const urls = []
  try {
    const url = board.urlOf(await board.serve())
    assert.ok(url)
    urls.push(url)
    const token = new URL(url).searchParams.get('t')
    const snapshot = () => { try { return JSON.parse(readFileSync(probe, 'utf8')) } catch { return null } }
    const poll = async () => {
      const before = snapshot()?.sequence ?? 0
      const response = await fetch(new URL('/api/board', url), { headers: { 'x-board-token': token } })
      assert.equal(response.status, 200)
      await response.arrayBuffer()
      for (let tries = 0; tries < 100; tries++) {
        const current = snapshot()
        if (current !== null && current.sequence > before) return current.counts
        await delay(10)
      }
      assert.fail('the owned page did not write its request counters')
    }
    const work = (before, after) => Object.keys(after).reduce((sum, key) => sum + after[key] - before[key], 0)
    await poll()
    const first = await poll()
    const small = work(first, await poll())
    for (let i = 0; i < 200; i++) {
      const hash = sha(`unrelated retired question ${i}`)
      writeFileSync(join(board.dir, `progress-questions-retired-${hash}.json`), proofJson('retired', hash))
    }
    await poll()
    const settled = await poll()
    const afterLarge = await poll()
    const large = work(settled, afterLarge)
    const extra = sha('one more unrelated retired question')
    writeFileSync(join(board.dir, `progress-questions-retired-${extra}.json`), proofJson('retired', extra))
    const changed = work(afterLarge, await poll())
    t.diagnostic(`question companion operations per page read: small=${small}, with 200 extra=${large}, one new=${changed}`)
    assert.ok(large <= small + 16, `metadata work grew from ${small} to ${large} operations`)
    assert.ok(changed <= small + 16, `one new companion caused ${changed} operations instead of bounded work near ${small}`)
  } finally {
    await board.end(urls)
  }
})

test('unchanged page polls reuse canonical question evidence without reparsing the ledger', { timeout: 30_000 }, async t => {
  const board = serveIn()
  const seed = chatRun(['--keys', ''], { file: askingBoard, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  writeFileSync(board.path, seed.board)
  for (const [name, text] of Object.entries(seed.files)) writeFileSync(join(board.dir, name), text)
  const probe = join(board.dir, 'question-allocation-counts.json')
  const preload = join(board.dir, 'question-allocation.cjs')
  writeFileSync(preload, questionFault(`if (process.argv.includes('--serve-child')) {
  const counts = { parsed: 0, ledgers: 0, captures: 0, ledgerBytes: 0, captureBytes: 0, progressScans: 0 }
  const progress = ${JSON.stringify(seed.board)}
  const split = String.prototype.split
  String.prototype.split = function (...args) { if (String(this) === progress) counts.progressScans += 1; return split.apply(this, args) }
  const parse = JSON.parse
  const stringify = JSON.stringify
  JSON.parse = (text, ...rest) => {
    const value = parse(text, ...rest)
    if (value?.version === 1 && Array.isArray(value.records)) counts.parsed += 1
    return value
  }
  JSON.stringify = (value, ...rest) => {
    const text = stringify(value, ...rest)
    if (value?.version === 1 && Array.isArray(value.records)) { counts.ledgers += 1; counts.ledgerBytes += Buffer.byteLength(text) }
    if (value?.version === 1 && value.record && value.disposition) { counts.captures += 1; counts.captureBytes += Buffer.byteLength(text) }
    return text
  }
  const http = require('node:http')
  const emit = http.Server.prototype.emit
  const write = fs.writeFileSync
  let sequence = 0
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request') args[1].once('finish', () => write(${JSON.stringify(probe)}, stringify({ sequence: ++sequence, counts })))
    return emit.call(this, event, ...args)
  }
}`))
  board.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  const urls = []
  try {
    const url = board.urlOf(await board.serve())
    assert.ok(url)
    urls.push(url)
    const token = new URL(url).searchParams.get('t')
    const snapshot = () => { try { return JSON.parse(readFileSync(probe, 'utf8')) } catch { return null } }
    const poll = async () => {
      const before = snapshot()?.sequence ?? 0
      const response = await fetch(new URL('/api/board', url), { headers: { 'x-board-token': token } })
      assert.equal(response.status, 200)
      await response.arrayBuffer()
      for (let tries = 0; tries < 100; tries++) {
        const current = snapshot()
        if (current !== null && current.sequence > before) return current.counts
        await delay(10)
      }
      assert.fail('the owned page did not write its allocation counters')
    }
    await poll()
    await poll()
    const before = await poll()
    const saved = readFileSync(join(board.dir, 'progress-questions.json'), 'utf8')
    await poll()
    await poll()
    const after = await poll()
    const delta = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]))
    t.diagnostic(`unchanged question JSON work over three page reads: ${JSON.stringify(delta)}`)
    assert.equal(delta.parsed, 0, 'unchanged validated ledger bytes were parsed again')
    assert.equal(delta.captures, 0, 'unchanged immutable captures were serialized again')
    assert.ok(delta.ledgers <= 3, `three reads serialized ${delta.ledgers} complete ledgers`)
    assert.equal(delta.progressScans, 0, 'unchanged progress source was scanned again')
    assert.equal(readFileSync(join(board.dir, 'progress-questions.json'), 'utf8'), saved)

    const old = JSON.parse(saved).records.find(record => record.isUnresolved && record.source)
    assert.ok(old)
    const copy = `${JSON.stringify({ version: 1, disposition: 'unresolved', record: { ...old, producerSources: ['synthetic-new-provenance'] } })}\n`
    writeFileSync(join(board.dir, `progress-questions-source-${sha(copy)}.json`), copy)
    await poll()
    const refreshed = JSON.parse(readFileSync(join(board.dir, 'progress-questions.json'), 'utf8')).records.find(record => record.id === old.id)
    assert.ok(refreshed.producerSources.includes('synthetic-new-provenance'))
    assert.equal(refreshed.firstObserved, old.firstObserved)
    assert.deepEqual(refreshed.source, old.source)
    const kept = `${JSON.stringify({ version: 1, disposition: 'unresolved', record: refreshed })}\n`
    const keptFile = join(board.dir, `progress-questions-source-${sha(kept)}.json`)
    assert.equal(readFileSync(keptFile, 'utf8'), kept)
    fs.unlinkSync(keptFile)
    await poll()
    assert.equal(readFileSync(keptFile, 'utf8'), kept, 'a removed durable source must be recreated before the ledger is accepted')
    const restored = JSON.parse(readFileSync(join(board.dir, 'progress-questions.json'), 'utf8')).records.find(record => record.id === old.id)
    assert.equal(restored.firstObserved, old.firstObserved)
    assert.deepEqual(restored.source, old.source)
  } finally {
    await board.end(urls)
  }
})

test('standalone question writes omit index whitespace while preserving every retained identity and source', () => {
  const seed = chatRun(['--keys', ''], { file: askingBoard, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const ledger = JSON.parse(seed.files['progress-questions.json'])
  assert.equal(seed.files['progress-questions.json'], JSON.stringify(ledger) + '\n')
  const pretty = JSON.stringify(ledger, null, 2) + '\n'
  const files = { ...seed.files, 'progress-questions.json': pretty }
  const unchanged = chatRun(['--keys', ''], { file: () => seed.board, beside: files, inspect: sweepFiles })
  assert.equal(unchanged.status, 0, unchanged.stderr)
  assert.equal(unchanged.files['progress-questions.json'], pretty, 'unchanged existing indexes retain their original bytes')
  const extended = seed.board + '\n## Synthetic addition\n### A new synthetic question\n- [?] Continue the synthetic plan, OK?\n'
  const changed = chatRun(['--keys', ''], { file: () => extended, beside: files, inspect: sweepFiles })
  assert.equal(changed.status, 0, changed.stderr)
  const next = JSON.parse(changed.files['progress-questions.json'])
  assert.equal(changed.files['progress-questions.json'], JSON.stringify(next) + '\n')
  assert.ok(next.records.length > ledger.records.length)
  for (const old of ledger.records) {
    const kept = next.records.find(record => record.id === old.id)
    assert.ok(kept, old.id)
    for (const key of ['scope', 'firstObserved', 'incarnation', 'producer', 'producerRevisions', 'producerSources', 'source']) assert.deepEqual(kept[key], old[key], `${old.id} ${key}`)
  }
  for (const [name, text] of Object.entries(seed.files)) if (/^progress-questions-source-/.test(name)) assert.equal(changed.files[name], text, 'source capture bytes and hashes must remain unchanged')
})

test('the terminal board forgets a question copy or proof that left the folder, so one that comes back is read again', () => {
  const board = askingBoard()
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  // The copy that leaves is the receipt of an answered question, which no board writes again as it does the copy of an open one.
  const ledger = JSON.parse(seed.files['progress-questions.json'])
  const old = ledger.records.find(record => record.words === 'Publish Old plan, OK?')
  const answered = { ...old, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: Date.now() - 200 * 3600000 }
  const receipt = `${JSON.stringify({ version: 1, disposition: 'resolved', record: answered })}\n`
  const copy = `progress-questions-source-${sha(receipt)}.json`
  const retired = `progress-questions-retired-${sha('an old question')}.json`
  const files = {
    ...seed.files,
    'progress-questions.json': `${JSON.stringify({ ...ledger, records: ledger.records.map(record => record.id === old.id ? answered : record) }, null, 2)}\n`,
    [copy]: receipt,
    [retired]: proofJson('retired', sha('an old question')),
  }
  const counted = chatRun(['--keys', 'down up '.repeat(12).trim()], {
    file: () => board, beside: files, inspect: sweepFiles,
    // The copy and the proof are left out of the listing for some of the looks in the middle, and listed as before after.
    preload: questionFault(`const counts = {}
const readFile = fs.readFileSync
fs.readFileSync = (file, ...rest) => { const name = String(file); if (/-questions-(source|retired|consumed)-/.test(name)) counts[path.basename(name)] = (counts[path.basename(name)] ?? 0) + 1; return readFile(file, ...rest) }
const hidden = ${JSON.stringify([copy, retired])}
const list = fs.readdirSync
let calls = 0
fs.readdirSync = (dir, ...rest) => { const names = list(dir, ...rest); if (!Array.isArray(names) || !String(dir).endsWith('.claude')) return names; calls += 1; return calls >= 6 && calls <= 14 ? names.filter(name => !hidden.includes(name)) : names }
process.on('exit', () => process.stderr.write('READS ' + JSON.stringify(counts) + '\\n'))`),
  })
  assert.equal(counted.status, 0, counted.stderr)
  const counts = JSON.parse(/READS (.*)/.exec(counted.stderr)[1])
  // Read when first listed, and once more when it came back; the files that never left were read once.
  assert.equal(counts[copy], 2, counted.stderr)
  assert.equal(counts[retired], 2, counted.stderr)
  for (const [name, count] of Object.entries(counts)) if (name !== copy && name !== retired) assert.equal(count, 1, counted.stderr)
})

test('--tidy starts again from the new text when another agent writes progress.md while it keeps a question', () => {
  const board = askingBoard()
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const added = '### Added by another agent\n- [ ] Not seen by the sweep\n'
  // Another agent appends to progress.md just as the sweep writes the copy of the old block's question for the archive.
  const swept = chatRun(['--tidy'], {
    file: () => board, beside: seed.files, inspect: sweepFiles,
    preload: questionFault(`const board = path.join(__dirname, 'progress.md')
const open = fs.openSync
let isChanged = false
fs.openSync = (file, ...rest) => {
  if (!isChanged && rest[0] === 'wx' && String(file).includes('-questions-source-')) {
    isChanged = true
    fs.appendFileSync(board, ${JSON.stringify(added)})
  }
  return open(file, ...rest)
}`),
  })
  assert.equal(swept.status, 0, swept.stderr)
  assert.equal(swept.stdout, 'Archived 1 task.\n')
  assert.ok(swept.board.includes('Added by another agent'), swept.board)
  assert.ok(!swept.board.includes('Old plan'), swept.board)
  assert.ok(swept.board.includes('Young plan'), swept.board)
  assert.equal(swept.archive.split('Publish Old plan, OK?').length - 1, 1, swept.archive)
  // The second try writes its own copy of the question, which now carries what the first one's copy added to the ledger.
  assert.deepEqual([...new Set(archivedCopies(swept.files).map(copy => copy.record.words))], ['Publish Old plan, OK?'])
})

test('--tidy on a board that changes on its first two tries archives the done block on the third and keeps the block that asks, and says the file was not updated when it changes on all three', () => {
  const at = Date.now()
  const done = `<!-- auto session=a1b2c323 agent=codex state=done updated=${new Date(at - 20 * 3600000).toISOString()} -->\n### Finished plan\n- [x] Ship it\n<!-- /auto session=a1b2c323 -->\n`
  const board = `${askingBoard()}${done}`
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  // Another agent adds a task each time the sweep writes a copy of a question (`copy`), or each
  // time it is about to replace progress.md (`rename`).
  const busy = at => questionFault(`const board = path.join(__dirname, 'progress.md')
const open = fs.openSync
let n = 0
fs.openSync = (file, ...rest) => {
  const name = path.basename(String(file))
  if (rest[0] === 'wx' && (${JSON.stringify(at)} === 'copy' ? name.includes('-questions-source-') : name.startsWith('progress.md.') && name.endsWith('.board-tmp'))) {
    n += 1
    fs.appendFileSync(board, '### Added by another agent ' + n + '\\n- [ ] Not seen by the sweep\\n')
  }
  return open(file, ...rest)
}`)
  // Every try that checks the block that asks finds the board changed; the third does not check it.
  const swept = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles, preload: busy('copy') })
  assert.equal(swept.status, 0, swept.stderr)
  assert.equal(swept.stdout, 'Archived 1 task.\n')
  assert.ok(swept.archive.includes('Finished plan'), swept.archive)
  assert.ok(!swept.board.includes('Finished plan'), swept.board)
  // The third try leaves the block that asks where it is; the next quiet sweep takes it.
  assert.ok(swept.board.includes('Old plan'), swept.board)
  assert.ok(!swept.archive.includes('Old plan'), swept.archive)
  assert.ok(swept.board.includes('Added by another agent 2'), swept.board)
  assert.ok(!swept.board.includes('Added by another agent 3'), swept.board)
  // Changed on every try, the sweep writes nothing over the other agent's task and says so.
  const stuck = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles, preload: busy('rename') })
  assert.equal(stuck.status, 1, stuck.stdout)
  assert.match(`${stuck.stdout}${stuck.stderr}`, /Couldn't safely read or update your progress file/)
  assert.ok(stuck.board.includes('Added by another agent 3'), stuck.board)
  assert.ok(stuck.board.includes('Finished plan'), stuck.board)
})

test('--tidy takes a block that asks on its last try when an earlier try archived it and it reads the same, and leaves one that changed since', () => {
  const at = Date.now()
  const done = `<!-- auto session=a1b2c323 agent=codex state=done updated=${new Date(at - 20 * 3600000).toISOString()} -->\n### Finished plan\n- [x] Ship it\n<!-- /auto session=a1b2c323 -->\n`
  const board = `${askingBoard()}${done}`
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  // Another agent writes progress.md twice: as the first try writes the archive, so that try starts
  // again, and as the second try checks the question, so the third is the last. With `isChanged`,
  // the second write also adds a step to the block that asks, after both checks read it.
  const twice = isChanged => questionFault(`const board = path.join(__dirname, 'progress.md')
const open = fs.openSync
let archives = 0
let copies = 0
fs.openSync = (file, ...rest) => {
  const name = path.basename(String(file))
  if (rest[0] === 'wx' && name.startsWith('progress-archive-') && name.endsWith('.board-tmp') && ++archives === 1) fs.appendFileSync(board, '### Added during the archive write\\n- [ ] Not seen by the sweep\\n')
  if (rest[0] === 'wx' && name.includes('-questions-source-') && ++copies === 2) {
    const text = fs.readFileSync(board, 'utf8') + '### Added during the question check\\n- [ ] Not seen either\\n'
    fs.writeFileSync(board, ${isChanged} ? text.replace('- [x] Draft\\n- [?] Publish Old plan', '- [x] Draft\\n- [x] Read it again\\n- [?] Publish Old plan') : text)
  }
  return open(file, ...rest)
}`)
  const swept = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles, preload: twice(false) })
  assert.equal(swept.status, 0, swept.stderr)
  // The first try archived the old block; the last one takes it out of the file, so it is counted once and is in one place.
  assert.equal(swept.stdout, 'Archived 2 tasks.\n')
  assert.ok(!swept.board.includes('Old plan'), swept.board)
  assert.ok(!swept.board.includes('Finished plan'), swept.board)
  assert.ok(swept.board.includes('Young plan'), swept.board)
  assert.ok(swept.board.includes('Added during the archive write') && swept.board.includes('Added during the question check'), swept.board)
  assert.equal(swept.archive.split('Publish Old plan, OK?').length - 1, 1, swept.archive)
  assert.equal(swept.archive.split('Finished plan').length - 1, 1, swept.archive)
  // Changed since the first try archived it, the block stays for the next sweep, and its newer text is not archived unchecked.
  const changed = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles, preload: twice(true) })
  assert.equal(changed.status, 0, changed.stderr)
  assert.ok(changed.board.includes('- [x] Read it again\n- [?] Publish Old plan, OK?'), changed.board)
  assert.ok(!changed.board.includes('Finished plan'), changed.board)
  assert.equal(changed.archive.split('Publish Old plan, OK?').length - 1, 1, changed.archive)
  assert.ok(!changed.archive.includes('Read it again'), changed.archive)
})

test('--tidy tells the blocks of two sessions with one title apart when it keeps their questions', () => {
  const at = Date.now()
  const block = (session, state, hours, steps) => `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(at - hours * 3600000).toISOString()} -->\n### Shared plan\n${steps}\n<!-- /auto session=${session} -->\n`
  const first = block('a1b2c331', 'ended', 100, '- [x] Draft\n- [?] First session question, OK?')
  const quiet = `## Synthetic\n${first}${block('a1b2c332', 'working', 1, '- [~] Work')}`
  const asking = `## Synthetic\n${first}${block('a1b2c332', 'working', 1, '- [~] Work\n- [?] Second session question, OK?')}`
  // The second session asks after the ledger was written: its question is not in the ledger yet, and it is not the first block's to wait for.
  const early = chatRun(['--keys', ''], { file: () => quiet, inspect: sweepFiles })
  assert.equal(early.status, 0, early.stderr)
  const unseen = chatRun(['--tidy'], { file: () => asking, beside: early.files, inspect: sweepFiles })
  assert.equal(unseen.status, 0, unseen.stderr)
  assert.equal(unseen.stdout, 'Archived 1 task.\n')
  assert.ok(!unseen.board.includes('First session question'), unseen.board)
  assert.ok(unseen.board.includes('Second session question'), unseen.board)
  assert.deepEqual(archivedCopies(unseen.files).map(copy => copy.record.words), ['First session question, OK?'])
  // With both questions in the ledger, only the first block's gets a copy for the archive.
  const both = chatRun(['--keys', ''], { file: () => asking, inspect: sweepFiles })
  assert.equal(both.status, 0, both.stderr)
  const swept = chatRun(['--tidy'], { file: () => asking, beside: both.files, inspect: sweepFiles })
  assert.equal(swept.status, 0, swept.stderr)
  assert.equal(swept.stdout, 'Archived 1 task.\n')
  assert.ok(swept.board.includes('Second session question'), swept.board)
  assert.deepEqual(archivedCopies(swept.files).map(copy => copy.record.words), ['First session question, OK?'])
})

test('--tidy keeps a working or waiting block that asks, however old, while the ledger holds its question', () => {
  const at = Date.now()
  const block = (session, state, hours) => `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(at - hours * 3600000).toISOString()} -->\n### Plan ${session}\n- [?] Question of ${session}, OK?\n<!-- /auto session=${session} -->\n`
  const board = `## Synthetic\n${block('a1b2c341', 'waiting', 100)}${block('a1b2c342', 'working', 24 * 40)}${block('a1b2c343', 'ended', 100)}`
  const seed = chatRun(['--keys', ''], { file: () => board, inspect: sweepFiles })
  assert.equal(seed.status, 0, seed.stderr)
  const swept = chatRun(['--tidy'], { file: () => board, beside: seed.files, inspect: sweepFiles })
  assert.equal(swept.status, 0, swept.stderr)
  assert.equal(swept.stdout, 'Archived 1 task.\n')
  assert.ok(swept.board.includes('a1b2c341') && swept.board.includes('a1b2c342'), swept.board)
  assert.ok(!swept.board.includes('a1b2c343'), swept.board)
  assert.deepEqual(archivedCopies(swept.files).map(copy => copy.record.words), ['Question of a1b2c343, OK?'])
})

test('--tidy reports scheduled ages in every language and takes precedence over interactive modes', () => {
  const expected = {
    en: 'Nothing is ready to archive. Agent blocks need more than 12 hours since their last update when done, or more than 3 days otherwise; completed hand-kept tasks need a completion observation at least 24 hours old. A block that still asks a question is archived only once it has ended or is done and the board has kept the question.',
    'zh-TW': '目前沒有可封存的項目。代理區塊最後更新後，已完成需超過 12 小時，其他需超過 3 天；手動完成項目需有至少 24 小時前的完成觀察紀錄。仍在提問的區塊，要等它已結束或已完成，且看板留存該問題後才會封存。',
    'zh-CN': '当前没有可归档的项目。代理区块最后更新后，已完成需超过 12 小时，其他需超过 3 天；手动完成项目需有至少 24 小时前的完成观察记录。仍在提问的区块，要等它已结束或已完成，且看板留存该问题后才会归档。',
  }
  for (const lang of ['en', 'zh-TW', 'zh-CN']) tidyFixture(f => {
    writeFileSync(f.path, `## Synthetic\n${f.block('a1b2c313', 'Done at the boundary', 'done', 12)}${f.block('a1b2c314', 'Stopped at the boundary', 'ended', 72)}### Unobserved manual\n- [x] Finished\n`)
    const guard = join(f.dir, 'no-interactive.cjs')
    // A precedence regression must fail without starting a server, browser or watch timer.
    writeFileSync(guard, "const cp = require('node:child_process'); const fail = () => { throw Error('UNEXPECTED_INTERACTIVE_PROCESS') }; for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = fail; require('node:module').syncBuiltinESMExports(); global.setInterval = fail;\n")
    const before = f.snapshot()
    for (const mode of [[], ['--serve'], ['--watch'], ['--html']]) {
      const result = f.command(['--tidy', '--lang', lang, ...mode], guard)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `${expected[lang]}\n`)
      assert.equal(result.stderr, '')
      assert.deepEqual(f.snapshot(), before)
    }
  })
})

test('--tidy uses recorded manual completion ages and preserves unknown or future observations', () => tidyFixture(f => {
  const titles = ['Old manual', 'Fresh manual', 'Unknown manual', 'Future manual']
  writeFileSync(f.path, `## Synthetic\n${titles.map(title => `### ${title}\n- [x] Finished\n`).join('')}`)
  const key = title => createHash('sha256').update(JSON.stringify(['Synthetic', title, [['done', 'Finished']]])).digest('hex')
  const record = JSON.stringify({ seen: {
    [key('Old manual')]: TIDY_NOW - 25 * 3600000,
    [key('Fresh manual')]: TIDY_NOW - 13 * 3600000,
    [key('Future manual')]: TIDY_NOW + 3600000,
  } })
  const seen = join(f.dir, 'progress-seen.json')
  writeFileSync(seen, record)
  const result = f.command()
  assert.equal(result.status, 0, result.stderr)
  const after = readFileSync(f.path, 'utf8')
  assert.ok(!after.includes('Old manual'), after)
  for (const title of titles.slice(1)) assert.ok(after.includes(title), after)
  assert.equal(readFileSync(seen, 'utf8'), record)
}))

test('--tidy ages each manual task by its own fingerprint with no project or a repeated title', () => tidyFixture(f => {
  writeFileSync(f.path, '### Outside project\n- [x] Outside step\n## Synthetic\n### Shared title\n- [x] Old step\n### Shared title\n- [x] Fresh step\n')
  const key = (project, title, step) => createHash('sha256').update(JSON.stringify([project, title, [['done', step]]])).digest('hex')
  const record = JSON.stringify({ seen: {
    [key('', 'Outside project', 'Outside step')]: TIDY_NOW - 25 * 3600000,
    [key('Synthetic', 'Shared title', 'Old step')]: TIDY_NOW - 25 * 3600000,
    [key('Synthetic', 'Shared title', 'Fresh step')]: TIDY_NOW - 3600000,
  } })
  const seen = join(f.dir, 'progress-seen.json')
  writeFileSync(seen, record)
  const result = f.command()
  assert.equal(result.status, 0, result.stderr)
  const after = readFileSync(f.path, 'utf8')
  assert.ok(!after.includes('Outside project'), after)
  assert.ok(!after.includes('Old step'), after)
  assert.ok(after.includes('### Shared title\n- [x] Fresh step'), after)
  const archive = readdirSync(f.dir).find(name => name.startsWith('progress-archive-'))
  const history = readFileSync(join(f.dir, archive), 'utf8')
  assert.ok(history.includes('Outside step') && history.includes('Old step'), history)
  assert.ok(!history.includes('Fresh step'), history)
  assert.equal(readFileSync(seen, 'utf8'), record)
}))

test('--chat stays read-only when combined with --tidy and a missing board creates no files', () => tidyFixture(f => {
  writeFileSync(f.path, `## Synthetic\n${f.block('a1b2c311', 'Old done', 'done', 24)}`)
  const before = f.snapshot()
  const result = f.command(['--chat', '--tidy', '--serve', '--html'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.snapshot(), before)
  rmSync(f.path)
  const absent = f.snapshot()
  assert.equal(f.command().status, 0)
  assert.deepEqual(f.snapshot(), absent)
}))

const IDLE_NOW = Date.parse('2026-10-17T12:00:00Z')
const IDLE_FILE = `## demo
### Quiet plan
- [?] Publish, OK?
- [ ] Finish
<!-- auto session=b1c2d3e4 agent=codex state=ended updated=2026-10-08T12:00:00Z -->
### Quiet block
- [ ] Finish automatically
<!-- /auto session=b1c2d3e4 -->
`
const idleRecord = () => JSON.stringify({ seen: {
  [createHash('sha256').update(JSON.stringify(['demo', 'Quiet plan', [['waiting', 'Publish, OK?'], ['todo', 'Finish']]])).digest('hex')]: IDLE_NOW - 9 * 24 * 60 * 60 * 1000,
} })
const idleQuestions = () => {
  const scope = JSON.stringify(['demo', 'manual', 'Quiet plan'])
  const words = 'Publish, OK?'
  const incarnation = 'idle-fixture:1'
  const binding = createHash('sha256').update(JSON.stringify([scope, words, 1, 1, incarnation])).digest('hex')
  return JSON.stringify({ version: 1, next: 2, records: [{ id: `question:${binding}:1`, scope, words, occurrence: 1, copies: 1, isWaiting: true, isPresent: true, firstObserved: IDLE_NOW - 9 * 24 * 60 * 60 * 1000, incarnation }], legacy: {} })
}
const idleRun = (args, beside = { 'progress-seen.json': idleRecord(), 'progress-questions.json': idleQuestions() }) => chatRun(args, {
  file: () => IDLE_FILE,
  beside,
  change: script => `Date.now = () => ${IDLE_NOW}\n${script}`,
})

test('Mark read on reminder and older terminal shelves saves the exact identity in every language', () => {
  const text = `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=2026-10-17T12:00:00Z -->\n### Release\n- [?] Publish, OK?\n<!-- /auto session=a1b2c3d4 -->\n`
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const days of [4, 8]) {
    const scope = JSON.stringify(['demo', 'codex', 'a1b2c3d4'])
    const words = 'Publish, OK?', incarnation = 'aged-action:1'
    const binding = createHash('sha256').update(JSON.stringify([scope, words, 1, 1, incarnation])).digest('hex')
    const record = { id: `question:${binding}:1`, scope, words, occurrence: 1, copies: 1, isWaiting: true, isPresent: true, firstObserved: IDLE_NOW - days * 86400000, incarnation }
    const fixture = {
      file: () => text, lang,
      beside: { 'progress-questions.json': JSON.stringify({ version: 1, next: 2, records: [record], legacy: {} }) },
      change: script => `Date.now = () => ${IDLE_NOW}\n${script}`,
    }
    const ran = chatRun(['--keys', 'l h'], fixture)
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.wrote.includes('progress-answered.json'), `${lang}/${days}: ${ran.stdout}`)
    assert.deepEqual(JSON.parse(ran.answered).answered, [record.id])
    assert.ok(!ran.modified.includes('progress.md'), ran.modified.join(','))
    const count = lang === 'en' ? '1 answered, hidden' : lang === 'zh-TW' ? '已回覆、隱藏的 1 項' : '已回复、隐藏的 1 项'
    assert.ok(ran.stdout.includes(count), ran.stdout)
    const restored = chatRun(['--keys', 'l h u'], fixture)
    assert.equal(restored.status, 0, restored.stderr)
    assert.deepEqual(JSON.parse(restored.answered).answered, [])
    assert.ok(restored.stdout.includes('Publish, OK?'), restored.stdout)
    assert.ok(!restored.modified.includes('progress.md'), restored.modified.join(','))
  }
})

test('the board script lists stopped tasks only with --all and names how many', () => {
  const fixture = {
    file: () => '## demo\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-17T11:00:00Z -->\n### Stopped plan\n- [ ] Finish\n<!-- /auto session=a1b2c3d4 -->',
    change: script => `Date.now = () => ${IDLE_NOW}\n${script}`,
  }
  for (const args of [[], ['--all'], ['--keys', 'i'], ['--keys', 'i i'], ['--chat']]) {
    const ran = chatRun(args, fixture)
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.stdout.includes('1 stopped'), ran.stdout)
    assert.ok(ran.stdout.includes('▸ 0 in progress'), ran.stdout)
    assert.equal(ran.stdout.includes('Stopped plan'), args.includes('--all') || args.includes('i'), ran.stdout)
    assert.deepEqual(ran.wrote, [])
    assert.deepEqual(ran.modified, [])
    assert.deepEqual(ran.served, [])
  }
})

test('the board script leaves idle tasks off the board, names how many, and lists them with --all', () => {
  const closed = idleRun([])
  assert.equal(closed.status, 0, closed.stderr)
  assert.ok(closed.stdout.includes('2 idle 7+ days'), closed.stdout)
  assert.ok(closed.stdout.includes('● 0 waiting') && closed.stdout.includes('▸ 0 in progress'), closed.stdout)
  assert.ok(!closed.stdout.includes('Quiet plan') && !closed.stdout.includes('Quiet block'), closed.stdout)
  assert.deepEqual(closed.wrote, [])
  assert.deepEqual(closed.modified, [])
  const opened = idleRun(['--all'])
  assert.equal(opened.status, 0, opened.stderr)
  assert.ok(opened.stdout.includes('Quiet plan') && opened.stdout.includes('Quiet block'), opened.stdout)
  assert.ok(opened.stdout.includes('9 days ago') && opened.stdout.includes('Publish, OK?'), opened.stdout)
  assert.deepEqual(opened.wrote, [])
  assert.deepEqual(opened.modified, [])
  const keys = idleRun(['--keys', 'i'])
  assert.equal(keys.status, 0, keys.stderr)
  assert.ok(keys.stdout.includes('Quiet plan') && keys.stdout.includes('Quiet block'), keys.stdout)
  assert.ok(idleRun(['--keys', 'i i']).stdout.includes('2 idle 7+ days'))
  assert.ok(!idleRun(['--keys', 'i i']).stdout.includes('Quiet plan'))
  const broken = idleRun([], { 'progress-seen.json': '{' })
  assert.equal(broken.status, 0, broken.stderr)
  assert.ok(broken.stdout.includes('Quiet plan'), broken.stdout)
})

test('the CLI view ages manual completions from sidecar fingerprints without renewing old or unknown times', () => {
  const file = '## demo\n### Old completion\n- [x] Old step\n### Fresh completion\n- [x] Fresh step\n### Unknown completion\n- [x] Unknown step\n### Future completion\n- [x] Future step\n'
  const key = (title, step) => createHash('sha256').update(JSON.stringify(['demo', title, [['done', step]]])).digest('hex')
  const record = JSON.stringify({ seen: {
    [key('Old completion', 'Old step')]: IDLE_NOW - 2 * 86400000,
    [key('Fresh completion', 'Fresh step')]: IDLE_NOW - 10 * 60000,
    [key('Future completion', 'Future step')]: IDLE_NOW + 86400000,
  } })
  for (const held of [record, '{', JSON.stringify({ seen: {} })]) {
    const html = htmlRun({ file, beside: { 'progress-seen.json': held }, now: IDLE_NOW })
    assert.ok(!/Old completion|Unknown completion|Future completion|just now/.test(html), html)
    assert.equal(html.includes('Fresh completion'), held === record, html)
  }
  // These surfaces currently omit recent completions; keep their existing output and
  // ensure chat never persists a new observation while constructing the shared view.
  for (const args of [[], ['--chat'], ['--keys', '']]) {
    const held = record
    const ran = chatRun(args, { file: () => file, beside: { 'progress-seen.json': held }, change: script => `Date.now = () => ${IDLE_NOW}\n${script}` })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(!/Old completion|Unknown completion|Future completion|just now/.test(ran.stdout), ran.stdout)
    assert.deepEqual(ran.modified, [])
    if (args.includes('--chat')) {
      assert.deepEqual(ran.wrote, [])
      assert.deepEqual(ran.served, [])
    }
  }
})

test("the board script's --chat run reads the seen record and writes nothing", () => {
  for (const args of [['--chat'], ['--chat', '--all', '--watch', '--serve', '--html', '--keys', 'i x']]) {
    const ran = idleRun(args)
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(ran.stdout.includes('2 idle 7+ days'), ran.stdout)
    assert.ok(ran.stdout.includes('Older unanswered questions') && ran.stdout.includes('Publish, OK?'), ran.stdout)
    assert.deepEqual(ran.wrote, [])
    assert.deepEqual(ran.modified, [])
    assert.deepEqual(ran.served, [])
  }
  const fresh = idleRun(['--chat'], {})
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.ok(fresh.stdout.includes('Publish, OK?'), fresh.stdout)
  assert.deepEqual(fresh.wrote, [])
  assert.deepEqual(fresh.modified, [])
})

test('default web and API refuse closed Codex and Grok sessions without starting a process', { timeout: 30_000 }, async () => {
  const board = await page()
  try {
    for (const agent of ['grok', 'codex']) {
      if (agent === 'codex') writeFileSync(board.path, readFileSync(board.path, 'utf8').replace('agent=grok', 'agent=codex'))
      const row = await board.rowOf('Pick the cache')
      assert.equal(row.send, 'open')
      assert.equal(row.hasCopyBox, true)
      assert.ok(row.resume?.includes(agent))
      const body = { key: row.key, type: 'send', text: 'Synthetic offline message', session: row.session, asked: row.question, fp: row.fp }
      assert.equal((await board.call('POST', '/api/act', { body })).status, 409)
      assert.equal((await board.call('POST', '/api/act', { body: { ...body, type: 'message', connection: 'forged', turn: 'session' } })).status, 409)
      assert.equal(existsSync(join(board.dir, 'grok-ran.json')), false)
    }
  } finally { await board.close() }
})

test('reopening a board replaces an explicit resume opt-in when that flag is removed', { timeout: 60_000 }, async () => {
  const board = serveIn()
  const urls = []
  try {
    for (const allow of [false, true, false]) {
      const url = board.urlOf(await board.serve(allow ? ['--allow-resume'] : []))
      assert.ok(url)
      if (urls.length) assert.notEqual(url, urls.at(-1))
      urls.push(url)
      const address = new URL(url)
      const ping = await fetchAt('127.0.0.1', Number(address.port), 'GET', '/api/ping', { 'x-board-token': address.searchParams.get('t') })
      assert.equal(ping.json().allowResume, allow)
    }
  } finally { await board.end(urls) }
})

const redesignPage = () => run('en', ['--chat'], {}, FILE, `${BOARD_SCRIPT}\nprocess.stdout.write(servePage(STRINGS.en, 'synthetic'))\n`)
const redesignSnapshot = () => htmlRun({ file: '## Synthetic\n### Plan\n- [ ] Continue\n' })
const themeScript = html => html.match(/<head>[\s\S]*?<script[^>]*>([\s\S]*?)<\/script>/)[1]
const themeDom = (html, storage = new Map(), isBlocked = false, jar = { value: '' }) => {
  const attributes = {}
  const classes = new Set()
  const root = {
    setAttribute: (name, value) => { attributes[name] = value },
    removeAttribute: name => { delete attributes[name] },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
  }
  const buttons = [...html.matchAll(/<button\b([^>]*data-theme-pick="([^"]+)"[^>]*)>/g)].map(found => {
    assert.match(found[1], /data-local/)
    const attrs = { 'data-theme-pick': found[2] }
    return { getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value } }
  })
  assert.equal(buttons.length, 3)
  const events = {}
  let finish
  runInNewContext(themeScript(html), {
    document: {
      documentElement: root, querySelectorAll: () => buttons, addEventListener: (name, run) => { events[name] = run },
      get cookie() { return jar.value },
      set cookie(line) {
        const pair = line.split(';')[0]
        const kept = jar.value.split('; ').filter(one => one !== '' && !one.startsWith(`${pair.split('=')[0]}=`))
        jar.value = [...kept, ...(/max-age=0\b/i.test(line) ? [] : [pair])].join('; ')
      },
    },
    localStorage: {
      getItem: key => { if (isBlocked) throw Error('blocked'); return storage.get(key) },
      setItem: (key, value) => { if (isBlocked) throw Error('blocked'); storage.set(key, value) },
      removeItem: key => { if (isBlocked) throw Error('blocked'); storage.delete(key) },
    },
    setTimeout: run => { finish = run }, clearTimeout: () => {},
  }, { timeout: 1000 })
  events.DOMContentLoaded()
  return {
    attributes, classes, buttons,
    pick: name => events.click({ target: { parentNode: buttons.find(button => button.getAttribute('data-theme-pick') === name) } }),
    finish: () => finish(),
  }
}

test('the serve page offers a light, dark and system theme and remembers the choice', () => {
  const html = redesignPage()
  const storage = new Map()
  const jar = { value: '' }
  const dom = themeDom(html, storage, false, jar)
  dom.pick('dark')
  assert.equal(storage.get('agent-board.theme'), 'dark')
  assert.equal(dom.attributes['data-theme'], 'dark')
  assert.deepEqual(dom.buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'true'])
  assert.ok(dom.classes.has('theming'))
  dom.finish()
  assert.ok(!dom.classes.has('theming'))
  // The live page starts on a new port each time, with empty storage; the cookie keeps the pick.
  assert.equal(themeDom(html, new Map(), false, jar).attributes['data-theme'], 'dark')
  const reload = themeDom(html, storage, false, jar)
  assert.equal(reload.attributes['data-theme'], 'dark')
  reload.pick('light')
  assert.equal(storage.get('agent-board.theme'), 'light')
  reload.pick('system')
  assert.equal(storage.has('agent-board.theme'), false)
  assert.equal(jar.value, '')
  assert.equal(reload.attributes['data-theme'], undefined)
  assert.equal(reload.buttons[0].getAttribute('aria-pressed'), 'true')
  assert.match(html, /<script nonce="synthetic">[\s\S]*agent-board.theme/)
  assert.match(html, /prefers-reduced-motion:reduce/)
})

test('progress.html keeps the chosen theme through its 30-second reload', () => {
  const html = redesignSnapshot()
  const storage = new Map([['agent-board.theme', 'light']])
  const dom = themeDom(html, storage)
  assert.equal(dom.attributes['data-theme'], 'light')
  let reloads = 0
  let tick
  const kept = new Map([['progress-open', '{"section:others":false}']])
  const events = {}
  const section = { id: '', open: true, getAttribute: () => 'section:others', addEventListener: (name, run) => { events[name] = run }, scrollIntoView: () => { section.scrolled = true } }
  let jump
  const button = { getAttribute: () => 'dash-others', addEventListener: (_, run) => { jump = run } }
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
  runInNewContext(script, {
    document: {
      querySelectorAll: selector => selector === 'details[data-key]' ? [section] : [button],
      getElementById: id => id === 'dash-others' ? section : null,
    },
    localStorage: { getItem: key => kept.get(key), setItem: (key, value) => kept.set(key, value) },
    sessionStorage: { getItem: () => '28', setItem: (_, value) => assert.equal(value, '42') },
    window: { scrollY: 42, scrollTo: (x, y) => assert.equal(y, 28) },
    setTimeout: (fn, delay) => { assert.equal(delay, 30000); tick = fn },
    location: { reload: () => { reloads += 1 } },
  }, { timeout: 1000 })
  assert.equal(section.id, 'dash-others')
  assert.equal(section.open, false)
  jump()
  assert.equal(section.open, true)
  assert.equal(section.scrolled, true)
  events.toggle()
  assert.equal(JSON.parse(kept.get('progress-open'))['section:others'], true)
  tick()
  assert.equal(reloads, 1)
  assert.equal(themeDom(html, storage).attributes['data-theme'], 'light')
})

test('the theme is applied before the page paints and survives blocked browser storage', () => {
  for (const html of [redesignPage(), redesignSnapshot()]) {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    assert.ok(head.indexOf('<script') < head.indexOf('<style'))
    assert.ok(!themeScript(html).includes('(function ()'))
    const dom = themeDom(html, new Map(), true)
    assert.equal(dom.attributes['data-theme'], undefined)
    dom.pick('dark')
    assert.equal(dom.attributes['data-theme'], 'dark')
    assert.equal(dom.buttons[2].getAttribute('aria-pressed'), 'true')
    assert.equal(themeDom(html, new Map([['agent-board.theme', 'unknown']])).attributes['data-theme'], undefined)
    assert.match(html, /:root:not\(\[data-theme="light"\]\)/)
    assert.match(html, /:root\[data-theme="dark"\]/)
  }
})

const redesignModel = () => {
  const row = (project, agent, title, due = '') => ({ key: title, project, agent, title, due, steps: [], total: 1, done: 0, status: 'Working', tone: 'accent', send: 'open' })
  const ask = (project, agent, text) => ({ key: text, project, agent, text, task: 'Plan', answers: [], kind: 'choose', chip: 'Choose', send: 'copy' })
  return {
    counts: { waiting: 2, active: 1, due: 1, today: 1 },
    asks: [ask('Alpha', 'codex', 'Alpha question'), ask('Beta', 'gemini', 'Beta question')],
    hidden: [], idle: [], stopped: [row('Beta', 'gemini', 'Stopped plan')],
    groups: [{ project: 'Alpha', rows: [row('Alpha', 'codex', 'Due plan', 'Tomorrow')] }],
    turns: [], recent: [{ project: 'Alpha', agent: 'codex', title: 'Finished plan', when: 'Today', questions: [] }],
  }
}
const descendants = root => [root, ...root.childNodes.flatMap(descendants)]
const visibleWords = root => root.hidden ? '' : root.text + root.childNodes.map(visibleWords).join('')
const sideButton = (dom, label) => descendants(dom.node('side-groups')).find(node => node.tag === 'button' && node.getAttribute('aria-label') === label)

// Source regressions can run before the maintainer rebuilds the committed board bundle.
const sourcePage = async (lang = 'en', words = {}) => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      return nextResolve(specifier, context)
    },
  })
  try {
    const [{ servePage }, { STRINGS }] = await Promise.all([import('../hooks/serve.ts'), import('../hooks/strings.ts')])
    return servePage({ ...STRINGS[lang], ...words }, 'synthetic')
  } finally { loader.deregister() }
}

const sourceAgentMarks = async () => {
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  } })
  try { return await import('../hooks/page-look.ts') } finally { loader.deregister() }
}

test('official agent marks retain their source viewport on every board surface', async () => {
  const { agentMarkCss } = await sourceAgentMarks()
  const css = agentMarkCss()
  const page = await sourcePage()
  assert.doesNotMatch(page, /\b[\da-f]{8}\b|\b[\da-f]{40}\b|\b[\da-f]{64}\b|(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\//i, 'brand SVG encoding keeps the default-page privacy contract')
  const official = {
    antigravity: ['0 0 180 180', 'cbc9e89e57b6ec9d4a155a53e84b722edc8f4ffcf9e33f6765bbd04cbca77422'],
    'deepseek-harness': ['0 0 50 50', '112fe133fd1d80bc5c7a785426e1ba6838458b1d21d3d8db9421273150c41182'],
  }
  for (const icon of AGENT_ICONS) {
    assert.match(icon.tile, /^#[0-9A-Fa-f]{6}$/, `${icon.file} keeps the README tile color contract`)
    assert.ok(icon.paths?.length, `${icon.file} has a verified brand shape`)
    const rule = css.match(new RegExp(`\\.ag-${icon.file}\\{([^}]+)\\}`))?.[1]
    const encoded = rule?.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)?.[1]
    assert.ok(encoded, icon.file)
    const svg = decodeURIComponent(encoded)
    assert.ok(svg.includes(`viewBox="${icon.viewBox ?? '0 0 24 24'}"`), icon.file)
    assert.ok(svg.includes(`fill="${icon.file === 'muse-code' ? 'rgb(0,130,251)' : 'white'}"`), icon.file)
    assert.equal(svg.includes('fill-rule="evenodd"'), !!icon.isEvenOdd, icon.file)
    const paths = [...svg.matchAll(/<path d="([^"]+)"\/>/g)].map(match => match[1].replace(/\s/g, ''))
    assert.deepEqual(paths, icon.paths.map(path => path.replace(/\s/g, '')), icon.file)
    assert.ok(page.includes(encoded), `served page: ${icon.file}`)
    assert.ok(BOARD_SCRIPT.includes(icon.paths[0]), `installed bundle: ${icon.file}`)
    if (icon.file === 'muse-code') {
      assert.equal(createHash('sha256').update(icon.paths[0]).digest('hex'), 'f8bffc5fd6188e1dbbc34e95fcef3e35c20450857252bc35c1a5af07f85b321f', 'Muse geometry matches its pinned library source')
      assert.equal(icon.ink, '#0082FB')
      assert.equal(icon.tile, '#FFFFFF')
      assert.ok(!css.includes('.ag-muse-code::before'))
      for (const prefix of ['', 'chip-']) {
        const image = readFileSync(new URL(`../docs/images/agents/${prefix}${icon.file}.svg`, import.meta.url), 'utf8')
        assert.ok(image.includes('fill="#0082FB"'))
        assert.ok(image.includes(`<path d="${icon.paths[0]}"/>`))
      }
      for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const theme of ['light', 'dark']) {
        const cover = readFileSync(new URL(`../docs/images/cover-${lang}-${theme}.svg`, import.meta.url), 'utf8')
        assert.ok(cover.includes(`<path d="${icon.paths[0]}"/>`), `Muse cover parity: ${lang}/${theme}`)
        assert.ok(cover.includes('fill="#0082FB"'), `Muse cover ink: ${lang}/${theme}`)
      }
    } else assert.equal(icon.ink, undefined, 'existing marks retain their white foreground')
    if (official[icon.file]) {
      const [viewBox, hash] = official[icon.file]
      assert.equal(icon.viewBox, viewBox)
      assert.equal(createHash('sha256').update(icon.paths[0]).digest('hex'), hash, 'official path geometry is unchanged')
      for (const prefix of ['', 'chip-']) {
        const image = readFileSync(new URL(`../docs/images/agents/${prefix}${icon.file}.svg`, import.meta.url), 'utf8')
        assert.ok(image.includes(`viewBox="${viewBox}"`), `preview viewport: ${prefix}${icon.file}`)
        assert.ok(image.includes(`<path d="${icon.paths[0]}"/>`), `preview geometry: ${prefix}${icon.file}`)
      }
    }
  }
})

test('agent aliases and fallback labels keep the correct identity without changing native acceptance', async () => {
  const { agentMark } = await sourceAgentMarks()
  assert.deepEqual(Object.fromEntries(AGENT_ICONS.map(icon => [icon.file, icon.isTested])), {
    'claude-code': true, codex: true, 'gemini-cli': true, cursor: false, opencode: true,
    'grok-build': true, 'hermes-agent': true, 'muse-code': false, antigravity: true,
    'deepseek-harness': false, openclaw: true,
  })
  for (const icon of AGENT_ICONS) {
    for (const alias of [icon.file, icon.file.split('-')[0], icon.name]) {
      assert.equal(agentMark(alias), `<span class="ag ag-${icon.file}" aria-hidden="true"></span>`, alias)
    }
  }
  assert.ok(agentMark('').includes('ag-claude-code'))
  assert.equal(agentMark('codex', true), '<span class="ag ag-own" aria-hidden="true"></span>')
  assert.equal(agentMark('constructor'), '<span class="ag ag-other" aria-hidden="true">C</span>')
  assert.equal(agentMark('<unknown>'), '<span class="ag ag-other" aria-hidden="true">&lt;</span>')
})

test('phone tiles and sidebar views count the same tasks, inbox updates and recent completions', async () => {
  const model = redesignModel()
  model.groups[0].rows.push({ ...model.groups[0].rows[0], key: 'Second plan', title: 'Second plan', due: '' })
  model.counts.active = 2
  model.turns = [{ key: 'turn', project: 'Alpha', agent: 'codex', text: 'Inbox update', isQuestion: false }]
  model.recent.push({ ...model.recent[0], title: 'Earlier plan', when: 'Yesterday' })
  model.reminder = [{ project: 'Alpha', agent: 'codex', text: 'Reminder question' }]
  model.idle = [{ ...model.groups[0].rows[0], title: 'Idle plan' }]
  const dom = await pageDom(await sourcePage(), model)
  const check = expected => {
    const tiles = dom.node('counts').childNodes
    for (const [index, label, symbol, count] of expected) {
      assert.ok(sideButton(dom, `${label} ${count}`), label)
      assert.equal(tiles[index].childNodes[0].textContent, `${symbol} ${count}`, label)
      assert.equal(tiles[index].childNodes[1].textContent, label)
      tiles[index].click()
      assert.equal(dom.node('scope').textContent, `${label}${count} ${count === 1 ? 'item' : 'items'}`)
    }
  }
  check([[1, 'In progress', '▸', 3], [0, 'Waiting on you', '●', 2], [2, 'Due soon', '⚑', 1], [3, 'Done recently', '✓', 2]])
  model.turns.push({ key: 'question', project: 'Beta', agent: 'gemini', text: 'Inbox question', isQuestion: true })
  await dom.redraw(model)
  check([[0, 'Waiting on you', '●', 3], [1, 'In progress', '▸', 4], [3, 'Done recently', '✓', 2]])
})

test('the serve page uses translated singular and plural item count templates', async () => {
  for (const [lang, one, many] of [['en', '1 item', '2 items'], ['zh-TW', '1 項', '2 項'], ['zh-CN', '1 项', '2 项']]) {
    const dom = await pageDom(await sourcePage(lang), redesignModel())
    dom.node('counts').childNodes[2].click()
    assert.equal(dom.node('scope').childNodes[1].textContent, one)
    dom.node('counts').childNodes[0].click()
    assert.equal(dom.node('scope').childNodes[1].textContent, many)
  }
  const dom = await pageDom(await sourcePage('en', { viewCountOne: n => `Only ${n} entry`, viewCount: n => `${n} entries` }), redesignModel())
  dom.node('counts').childNodes[2].click()
  assert.equal(dom.node('scope').childNodes[1].textContent, 'Only 1 entry')
})

test('offline notices and board warnings use the alert contrast colours', async () => {
  const html = await sourcePage()
  const model = { ...redesignModel(), warning: 'Synthetic warning' }
  const dom = await pageDom(html, model)
  assert.equal(descendants(dom.node('board')).find(node => node.textContent === model.warning).className, 't-alert')
  const offline = html.match(/#offline:not\(:empty\)\{([^}]+)\}/)[1]
  assert.ok(offline.includes('background:color-mix(in srgb,var(--alert) 9%,var(--ground))'))
  assert.ok(offline.includes('border-color:color-mix(in srgb,var(--alert) 35%,var(--line))'))
  assert.match(html, /\.t-alert,\.s-blocked\{color:var\(--alert\)\}/)
})

test('the serve page sidebar sorts the board by view, project and agent with counts', async () => {
  const model = redesignModel()
  const dom = await pageDom(redesignPage(), model)
  for (const label of ['Everything 5', 'Waiting on you 2', 'In progress 1', 'Due soon 1', 'Stopped 1', 'Done recently 1', 'Alpha 3', 'Beta 2', 'codex 3', 'gemini 2']) assert.ok(sideButton(dom, label), label)
  assert.equal(descendants(dom.node('board')).find(node => node.className?.includes('ag-codex')).getAttribute('aria-hidden'), 'true')
  dom.boxes()[0].value = 'Synthetic draft'
  sideButton(dom, 'Alpha 3').click()
  assert.ok(visibleWords(dom.node('board')).includes('Alpha question'))
  assert.ok(!visibleWords(dom.node('board')).includes('Beta question'))
  assert.ok(dom.node('scope').textContent.includes('3 items'))
  assert.equal(sideButton(dom, 'Everything 5').getAttribute('aria-pressed'), 'true')
  await dom.redraw({ ...model, warning: 'Synthetic warning' })
  assert.equal(sideButton(dom, 'Alpha 3').getAttribute('aria-pressed'), 'true')
  assert.ok(dom.boxes().some(box => box.value === 'Synthetic draft'))
  sideButton(dom, 'Done recently 1').click()
  const shown = visibleWords(dom.node('board'))
  assert.ok(shown.includes('Finished plan'))
  assert.ok(shown.includes('Synthetic warning'))
  for (const text of ['Alpha question', 'Beta question', 'Due plan', 'Stopped plan']) assert.ok(!shown.includes(text), text)
  assert.ok(dom.node('scope').textContent.includes('1 item'))
  dom.node('side-open').click()
  assert.equal(dom.node('side-open').getAttribute('aria-expanded'), 'true')
  dom.key({ key: 'Escape' })
  assert.equal(dom.node('side-open').getAttribute('aria-expanded'), 'false')
  const own = redesignModel()
  // A hand-kept task is the person's own; a Claude Code block has the same '' agent without isOwn.
  own.groups[0].rows[0] = { ...own.groups[0].rows[0], agent: '', isOwn: true }
  own.groups[0].rows.push({ ...own.groups[0].rows[0], key: 'Claude plan', title: 'Claude plan', isOwn: undefined })
  // The model carries no agent for a finished item; it is counted under no agent.
  delete own.recent[0].agent
  await dom.redraw(own)
  assert.ok(sideButton(dom, 'Your own tasks 1'))
  assert.ok(sideButton(dom, 'claude 1'))
  for (const mark of ['ag ag-own', 'ag ag-claude-code']) assert.ok(descendants(dom.node('board')).some(node => node.className === mark), mark)
  const full = redesignModel()
  full.reminder = [{ project: 'Alpha', agent: 'codex', task: 'Retained', text: 'Reminder question' }]
  full.older = [{ project: 'Beta', agent: 'gemini', task: 'Retained', text: 'Older question' }]
  full.hidden = [{ key: 'hidden', project: 'Beta', agent: 'gemini', text: 'Hidden question' }]
  full.idle = [{ ...full.groups[0].rows[0], key: 'idle', project: 'Beta', agent: 'gemini', title: 'Idle plan', due: '' }]
  full.turns = [{ key: 'question', project: 'Alpha', agent: 'codex', text: 'Inbox question', isQuestion: true }, { key: 'turn', project: 'Beta', agent: 'constructor', text: 'Inbox update', isQuestion: false }]
  await dom.redraw(full)
  // Shelf entries (reminders, older and hidden questions, the idle task) filter but are not
  // counted, as the counts above the board leave them out.
  for (const label of ['Everything 7', 'Waiting on you 3', 'In progress 3', 'Due soon 1']) assert.ok(sideButton(dom, label), label)
  descendants(dom.node('scope')).find(node => node.getAttribute('aria-label') === 'Remove the Alpha filter').click()
  sideButton(dom, 'Waiting on you 3').click()
  for (const text of ['Reminder question', 'Older question', 'Hidden question', 'Inbox question']) assert.ok(visibleWords(dom.node('board')).includes(text), text)
  assert.ok(!visibleWords(dom.node('board')).includes('Inbox update'))
  sideButton(dom, 'Due soon 1').click()
  assert.ok(visibleWords(dom.node('board')).includes('Due plan'))
  for (const text of ['Idle plan', 'Reminder question', 'Older question', 'Hidden question', 'Inbox question']) assert.ok(!visibleWords(dom.node('board')).includes(text), text)
  sideButton(dom, 'In progress 3').click()
  assert.ok(visibleWords(dom.node('board')).includes('Idle plan'))
  const unknown = descendants(dom.node('board')).find(node => node.className === 'ag ag-other' && node.textContent === 'C')
  assert.ok(unknown)
})

test("a sidebar filter that matches nothing shows that view's empty state and a way to clear it", async () => {
  const dom = await pageDom(redesignPage(), redesignModel())
  sideButton(dom, 'Stopped 1').click()
  sideButton(dom, 'codex 3').click()
  assert.ok(visibleWords(dom.node('board')).includes('Nothing here for codex.'))
  assert.ok(!visibleWords(dom.node('board')).includes('Stopped plan'))
  const clear = dom.allButtons().find(button => button.textContent === 'Clear filters')
  assert.ok(clear && !clear.hidden)
  clear.click()
  assert.ok(visibleWords(dom.node('board')).includes('Stopped plan'))
  assert.ok(!visibleWords(dom.node('board')).includes('Nothing here for codex.'))
  sideButton(dom, 'gemini 2').click()
  const chip = descendants(dom.node('scope')).find(node => node.getAttribute('aria-label') === 'Remove the gemini filter')
  assert.ok(chip)
  chip.click()
  assert.equal(sideButton(dom, 'gemini 2').getAttribute('aria-pressed'), 'false')
  const blank = { counts: { waiting: 0, active: 0, due: 0, today: 0 }, asks: [], hidden: [], idle: [], stopped: [], groups: [], turns: [], recent: [] }
  await dom.redraw(blank)
  assert.ok(visibleWords(dom.node('board')).includes('Nothing has stopped'))
  sideButton(dom, 'Due soon 0').click()
  assert.ok(visibleWords(dom.node('board')).includes('Nothing due soon'))
  sideButton(dom, 'Done recently 0').click()
  assert.ok(visibleWords(dom.node('board')).includes('Nothing finished recently'))
  sideButton(dom, 'Everything 0').click()
  // With no questions the waiting heading says nothing needs you, once.
  assert.ok(visibleWords(dom.node('board')).includes('Waiting on you'))
  assert.equal(visibleWords(dom.node('board')).split('Nothing needs you right now').length, 2)
})

test('sidebar filters keep hidden-question and recent-action results beside their controls', async () => {
  const model = redesignModel()
  model.hidden = [{ key: 'hidden-demo', project: 'Alpha', agent: 'codex', task: 'Hidden plan', text: 'Hidden question' }]
  const dom = await pageDom(await sourcePage(), model, { post: async () => ({ ok: false, json: async () => ({ note: 'Synthetic refusal' }) }) })
  sideButton(dom, 'Waiting on you 2').click()
  const show = dom.buttons().find(button => button.textContent === EN.showAgain)
  assert.equal(pageCard(show).getAttribute('data-card-key'), 'hidden-demo')
  show.click()
  assert.equal(pageCardResults(dom, 'hidden-demo')[0].textContent, EN.pressPending)
  await dom.settle()
  assert.equal(pageCardResults(dom, 'hidden-demo')[0].textContent, 'Synthetic refusal')
  await dom.redraw({ ...model, warning: 'Synthetic warning' })
  assert.ok(visibleWords(dom.node('board')).includes('Synthetic refusal'))
  assert.equal(pageCardResults(dom, 'hidden-demo')[0].textContent, 'Synthetic refusal')
  sideButton(dom, 'Done recently 1').click()
  // A filter click changes only what is shown: the hidden question's result is still there.
  assert.equal(pageCardResults(dom, 'hidden-demo')[0].textContent, 'Synthetic refusal')
  const archive = dom.buttons().find(button => button.textContent === EN.archiveNow)
  assert.equal(pageCard(archive).getAttribute('data-card-key'), 'recent')
  archive.click()
  assert.equal(pageCardResults(dom, 'recent')[0].textContent, EN.pressPending)
  await dom.settle()
  assert.equal(pageCardResults(dom, 'recent')[0].textContent, 'Synthetic refusal')
  assert.ok(visibleWords(dom.node('board')).includes('Synthetic refusal'))
  assert.equal(dom.node('note').textContent, '')
})

test('the theme switch and the sidebar keep working while the board is unreachable', async () => {
  const html = redesignPage()
  const model = redesignModel()
  let isOffline = false
  const dom = await pageDom(html, model, { getBoard: async () => {
    if (isOffline) throw Error('Synthetic offline')
    return { ok: true, json: async () => ({ model, now: 1 }) }
  } })
  isOffline = true
  await dom.redraw(model)
  await dom.settle()
  assert.ok(dom.node('offline').textContent.includes("Can't reach the board"))
  for (const node of descendants(dom.node('side-groups')).filter(node => node.tag === 'button')) assert.ok(!node.disabled && node.getAttribute('data-local') !== null)
  sideButton(dom, 'Beta 2').click()
  assert.ok(visibleWords(dom.node('board')).includes('Beta question'))
  assert.ok(!visibleWords(dom.node('board')).includes('Alpha question'))
  assert.equal(dom.requests.length, 0)
  const theme = themeDom(html)
  theme.pick('dark')
  assert.equal(theme.attributes['data-theme'], 'dark')
})

test('L2 page: a step circle either ticks the step or does not look clickable', async () => {
  const html = redesignPage()
  const model = redesignModel()
  const row = model.groups[0].rows[0]
  row.steps = ['done', 'doing', 'todo'].map(status => ({ status, text: `Synthetic ${status}`, note: '', isCurrent: status === 'doing' }))
  row.total = 3
  row.done = 1
  const dom = await pageDom(html, model)
  const marks = descendants(dom.node('board')).filter(node => node.className?.startsWith('mk '))
  assert.equal(marks.length, 3)
  for (const mark of marks) {
    assert.equal(mark.tag, 'span')
    assert.equal(mark.getAttribute('role'), null)
    assert.equal(mark.getAttribute('tabindex'), null)
    assert.equal(mark.events.click, undefined)
    assert.equal(mark.onclick, undefined)
    assert.notEqual(mark.textContent, '\u25cb')
  }
  assert.deepEqual(marks.map(mark => mark.textContent), ['\u2713', '\u25b8', '\u2022'])
  const snapshot = htmlRun({ file: '## Synthetic\n### Plan\n- [x] Synthetic done\n- [~] Synthetic doing\n- [ ] Synthetic todo\n' })
  for (const [page, selector] of [[html, /\.steps \.mk\s*\{([^}]*)\}/g], [snapshot, /\.steps \.g\s*\{([^}]*)\}/g]]) {
    const rules = [...page.matchAll(selector)].map(match => match[1])
    assert.ok(rules.length > 0)
    for (const rule of rules) {
      assert.doesNotMatch(rule, /(?:^|;)\s*border(?:-[\w-]+)?\s*:/i)
      assert.doesNotMatch(rule, /cursor\s*:\s*pointer/i)
      assert.doesNotMatch(rule, /(?:^|;)\s*background(?:-[\w-]+)?\s*:/i)
    }
    assert.ok(rules.some(rule => /width\s*:\s*22px/.test(rule)))
    assert.ok(rules.some(rule => /cursor\s*:\s*default/.test(rule)))
    assert.ok(rules.some(rule => /user-select\s*:\s*none/.test(rule)))
  }
  const stepMarks = [...snapshot.matchAll(/<span class="g"[^>]*>([^<]*)<\/span>/g)].map(match => match[1])
  assert.ok(stepMarks.includes('\u2713'))
  assert.ok(stepMarks.includes('\u25b8'))
  assert.ok(stepMarks.includes('\u2022'))
  assert.ok(!stepMarks.includes('\u25cb'))
  assert.match(snapshot, /<span class="g"[^>]*>\u2022<\/span><span class="t">Synthetic todo<\/span>/)
  const legend = snapshot.match(/<div class="legend">([\s\S]*?)<\/div>/)[1]
  assert.match(legend, /<span[^>]*>\u2022<\/span> To do/)
  assert.doesNotMatch(legend, /\u25cb/)
})

test('a watch view that captured a question before progress.md was locked says files may have changed', () => {
  const ran = chatRun(['--watch'], {
    inspect: questionFiles,
    preload: questionFault(`let isHeld = false
const read = fs.readFileSync
fs.readFileSync = (file, ...args) => {
  if (isHeld && file === path.join(__dirname, 'progress.md')) throw Object.assign(new Error('injected busy read'), { code: 'EBUSY' })
  return read(file, ...args)
}
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
  const result = write(chunk, ...args)
  if (isHeld) process.exit(1)
  isHeld = true
  return result
}
global.setInterval = callback => { callback(); return { unref() {} } }
`),
  })
  assert.equal(ran.status, 1, ran.stderr)
  assert.ok(Object.keys(ran.files).some(name => name.startsWith('progress-questions-source-')), JSON.stringify(Object.keys(ran.files)))
  assert.match(ran.stderr, /some changes may already be saved/)
  assert.doesNotMatch(ran.stderr, /nothing was changed/)
})

// Import the pure renderer so these regressions do not depend on a maintainer bundle rebuild.
const sourceBoard = async () => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      return nextResolve(specifier, context)
    },
  })
  try {
    const [board, view, parse] = await Promise.all([import('../hooks/board.ts'), import('../hooks/view.ts'), import('../hooks/parse.ts')])
    return { ...board, ...view, ...parse }
  } finally { loader.deregister() }
}

const terminalWidth = text => [...text.replace(/\x1b\[[0-9;]*m/g, '')].reduce((sum, char) => sum + (/[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{20000}-\u{3fffd}\p{Emoji_Presentation}]/u.test(char) ? 2 : 1), 0)

test('the terminal board keeps group headings, --all question shelves and the due badge within the width in en, zh-TW and zh-CN', async () => {
  const { boardText, boardScreen, emptyBoardState, buildView, parseProgress } = await sourceBoard()
  const now = Date.parse('2026-10-25T12:00:00Z')
  const project = `Synthetic basin ${'流域 planning ✅ '.repeat(18)}`
  const task = `Synthetic task ${'水庫 release schedule '.repeat(18)}`
  const source = `## ${project}\n### ${task}\n> due 10-27\n- [ ] ${'核對 compare totals '.repeat(18)}\n<!-- auto session=38300001 agent=codex state=working updated=2026-10-25T12:00:00Z -->\n### Working ${task}\n- [~] ${'✅計算 compare '.repeat(18)}\n<!-- /auto session=38300001 -->\n`
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const parsed = buildView(parseProgress(source), [], null, now, 0, {}, s)
    assert.equal(parsed.due.length, 1, s.lang)
    assert.equal(parsed.groups.length, 1, 'a working group heading is rendered')
    const view = { ...parsed, reminder: [{ project, task, text: `Reminder ${task}`, note: task, when: '4 days' }], older: [{ project, task, text: `Older ${task}`, note: task, when: '8 days' }] }
    for (const width of [100, 160]) for (const isColor of [false, true]) {
      const text = boardText(view, [], s, { width, isColor, isIdleOpen: true })
      const screen = boardScreen(view, [], emptyBoardState, s, { width, isColor })
      for (const output of [text, screen]) {
        assert.ok(output.includes('Synthetic basin'), 'the project remains visible')
        assert.ok(output.includes('Synthetic task'), 'the task remains visible')
        assert.ok(output.includes('…'), 'long fixture content is actually cut')
        for (const line of output.split('\n')) assert.ok(terminalWidth(line) <= width, `${s.lang} / ${width}: ${terminalWidth(line)} columns: ${line}`)
      }
      assert.ok(text.includes('Reminder') && text.includes('Older'), 'both question shelves are rendered')
      const badge = `⚑ ${parsed.due[0].due.left}`
      const badgeLine = screen.split('\n').find(line => line.includes(badge))
      assert.ok(badgeLine?.includes('…'), `the complete due badge stays after the clipped status: ${screen}`)
    }
  }
})

test('an emoji counts as two columns when a board line is cut to the width', async () => {
  const { fit, chatText, buildView, parseProgress } = await sourceBoard()
  for (const emoji of ['✅', '😀', '🧪']) {
    assert.equal(fit(emoji.repeat(5), 10), emoji.repeat(5))
    assert.equal(fit(emoji.repeat(6), 10), `${emoji.repeat(4)}…`)
    assert.ok(terminalWidth(fit(`${emoji}漢${emoji}`, 5)) <= 5)
  }
  assert.equal(fit('漢字漢字', 5), '漢字…')
  const title = '✅'.repeat(150)
  const view = buildView(parseProgress(`## Chat\n### ${title}\n- [ ] Next\n`), [], null, Date.parse('2026-10-25T12:00:00Z'), 0, {}, EN)
  assert.ok(chatText(view, [], [], EN, '/synthetic-home').includes(title), '--chat keeps its existing line budget rather than terminal emoji widths')
})

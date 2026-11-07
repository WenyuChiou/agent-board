import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const block = (id, state, steps, minutes = 5, agent = 'codex', extra = '') =>
  `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - minutes * 60_000).toISOString()} ${extra} -->\n### Synthetic ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
const FILE = '## Synthetic project\n' +
  block('aaaa1111', 'waiting', '- [?] First choice?') +
  block('bbbb2222', 'waiting', '- [?] Continue, OK?', 10, 'claude') +
  ['cccc3333', 'dddd4444', 'eeee5555'].map(id => block(id, 'working', '- [~] Write a test')).join('') +
  block('ffff6666', 'done', '- [x] Finished') +
  block('aaaa7777', 'ended', '- [ ] Unfinished') +
  block('aaaa8888', 'working', '- [~] Stale work', 13 * 60) +
  block('aaaa9999', 'waiting', '- [ ] Quiet turn', 40) +
  block('bbbb0000', 'working', '- [~] Background child', 5, 'codex', 'origin=run parent=cccc3333') +
  '### Hand-kept plan\n- [ ] Review\n'

// The guard runs before the installed bundle: reading anything beyond progress.md, its two
// sidecars (answered, questions) and the inbox folder, writing, polling or launching anything
// fails the command (#832). The inbox is read so --status counts a waiting turn like the
// page and the terminal (#1000).
const guard = `import { createRequire as statusCreateRequire } from 'node:module'
{
const require = statusCreateRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { resolve, dirname } = require('node:path')
const read = fs.readFileSync
const readdir = fs.readdirSync
const progressFile = resolve(process.env.STATUS_PROGRESS)
const answeredFile = resolve(process.env.STATUS_PROGRESS.replace(/\\.md$/i, '') + '-answered.json')
const questionsFile = resolve(process.env.STATUS_PROGRESS.replace(/\\.md$/i, '') + '-questions.json')
const reads = { progress: 0, answered: 0, questions: 0, inboxDir: 0, inbox: {} }
const inboxDir = resolve(dirname(progressFile), 'progress-inbox')
const violations = []
fs.readFileSync = (file, ...args) => {
  const target = resolve(String(file))
  if (target === progressFile) {
    reads.progress++
    if (process.env.STATUS_DENIED) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(file, ...args)
  }
  if (target === answeredFile) {
    reads.answered++
    if (process.env.STATUS_DENIED_SIDECAR === 'answered') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(file, ...args)
  }
  if (target === questionsFile) {
    reads.questions++
    if (process.env.STATUS_DENIED_SIDECAR === 'questions') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(file, ...args)
  }
  if (target.startsWith(inboxDir + '/')) {
    reads.inbox[target] = (reads.inbox[target] ?? 0) + 1
    return read(file, ...args)
  }
  violations.push(String(file))
  throw new Error('only progress.md, its sidecars and the inbox may be read')
}
fs.readdirSync = (dir, ...args) => {
  if (resolve(String(dir)) === inboxDir) {
    reads.inboxDir++
    return readdir(dir, ...args)
  }
  violations.push(String(dir))
  throw new Error('only the inbox directory may be listed')
}
const refused = () => { violations.push(new Error().stack); throw new Error('status must not write, inspect other files, poll or start anything') }
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'openSync', 'statSync', 'watch', 'watchFile']) fs[name] = refused
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = refused
for (const name of ['node:http', 'node:https', 'node:net']) require(name).createServer = refused
global.setInterval = refused
Date.now = () => ${NOW}
syncBuiltinESMExports()
process.on('exit', () => {
  assert.deepEqual(violations, [], 'no forbidden operation was attempted, even if its error was caught')
  assert.equal(reads.progress, 1, 'progress.md is read exactly once')
  assert.ok(reads.answered <= 1, 'answered file is read at most once')
  assert.ok(reads.questions <= 1, 'questions ledger is read at most once')
  assert.ok(reads.inboxDir <= 1, 'inbox directory is listed at most once')
  for (const [file, count] of Object.entries(reads.inbox)) assert.ok(count <= 1, 'inbox file is read at most once: ' + file)
})
}
`

const run = (args = [], { file = FILE, answered = null, questions = null, lang = 'en', denied = false, launcher = false, inbox = null, deniedSidecar = null } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-status-'))
  try {
    const path = join(root, 'progress.md')
    if (file !== null) writeFileSync(path, file)
    if (answered !== null) writeFileSync(join(root, 'progress-answered.json'), typeof answered === 'string' ? answered : JSON.stringify(answered))
    if (questions !== null) writeFileSync(join(root, 'progress-questions.json'), typeof questions === 'string' ? questions : JSON.stringify(questions))
    if (inbox !== null) {
      mkdirSync(join(root, 'progress-inbox'))
      for (const turn of inbox) writeFileSync(join(root, 'progress-inbox', turn.name), turn.body)
    }
    const script = join(root, 'agent-board.mjs')
    writeFileSync(script, `${guard}\nglobalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const before = readdirSync(root).sort()
    const command = launcher ? [fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url)), '--progress-file', path] : [script]
    const result = spawnSync(process.execPath, [...command, '--status', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: root, CLAUDE_PROGRESS_FILE: '', XDG_CONFIG_HOME: root, XDG_RUNTIME_DIR: root, LOCALAPPDATA: root, APPDATA: root, HERMES_HOME: root, OPENCLAW_STATE_DIR: root, OPENCODE_CONFIG_DIR: root, DSH_HOME: root, GROK_HOME: root, STATUS_PROGRESS: path, STATUS_DENIED: denied ? '1' : '', STATUS_DENIED_SIDECAR: deniedSidecar ?? '', NO_COLOR: undefined, FORCE_COLOR: '3' },
    })
    assert.equal(result.error, undefined)
    assert.deepEqual(readdirSync(root).sort(), before)
    if (file !== null) assert.equal(readFileSync(path, 'utf8'), file)
    return result
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the status line counts what needs you and what is working in one line and writes nothing', () => {
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout, '2 need you · 3 working\n')
})

test('the status line uses all three languages and an explicit language overrides the installed one', () => {
  for (const [lang, expected] of [['en', '2 need you · 3 working'], ['zh-TW', '2 項等你 · 3 項進行中'], ['zh-CN', '2 项等你 · 3 项进行中']]) {
    const result = run(['--lang', lang], { lang: 'zh-TW' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${expected}\n`)
    assert.equal(result.stderr, '')
  }
})

test('the status line for an empty or missing progress file prints zero without creating files', () => {
  for (const file of ['', null]) {
    const result = run([], { file })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '0 need you · 0 working\n')
    assert.equal(result.stderr, '')
  }
})

test('status wins over flags that could start services, write files or run a host adapter', () => {
  for (const args of [
    ['--watch', '--serve', '--html', '--tidy', '--keys', 'x', '--chat'],
    ['--codex-setup', '--agent', 'codex'],
    ['--legacy-connect-request', '{}'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '2 need you · 3 working\n')
    assert.equal(result.stderr, '')
  }
})

test('an unreadable status file fails without printing a misleading zero count', () => {
  const result = run([], { denied: true })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.length > 0)
  assert.ok(!result.stderr.includes('0 need you'))
})

test('the npm launcher forwards status without a build-comparison notice on every poll', () => {
  const result = run(['--lang', 'en'], { launcher: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2 need you · 3 working\n')
  assert.equal(result.stderr, '')
})

test('the status line leaves out hidden questions when answered or questions sidecars exist (#832)', () => {
  // aaaa1111's question is hidden via answered sidecar; back in working
  const answered = { answered: ['aaaa1111 1 First choice?'] }
  const result = run([], { answered })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '1 need you · 4 working\n')
  assert.equal(result.stderr, '')
})

test('the status line falls back to progress.md counts when sidecars cannot be read or are invalid (#832)', () => {
  const result = run([], { answered: '{ broken json' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2 need you · 3 working\n')
  assert.equal(result.stderr, '')
})

test('the status line falls back to progress.md counts when a sidecar with a real hide key cannot be read, is oversized or is invalid (#1000)', () => {
  const hide = 'aaaa1111 1 First choice?'
  // Broken JSON that still names the hidden question: a partial parse must not apply it.
  const broken = run([], { answered: `{"answered": ["${hide}"]` })
  assert.equal(broken.status, 0, broken.stderr)
  assert.equal(broken.stdout, '2 need you · 3 working\n')
  assert.equal(broken.stderr, '')
  // Over the size cap: the truncated sidecar must not apply the hide either.
  const oversized = run([], { answered: JSON.stringify({ answered: [hide], pad: 'x'.repeat(600_000) }) })
  assert.equal(oversized.status, 0, oversized.stderr)
  assert.equal(oversized.stdout, '2 need you · 3 working\n')
  assert.equal(oversized.stderr, '')
  // Unreadable: the guard refuses the answered file, as a permission error would.
  const denied = run([], { answered: { answered: [hide] }, deniedSidecar: 'answered' })
  assert.equal(denied.status, 0, denied.stderr)
  assert.equal(denied.stdout, '2 need you · 3 working\n')
  assert.equal(denied.stderr, '')
})

test('the status line counts a turn waiting in the inbox, like the page and the terminal (#1000)', async () => {
  const turnFile = `codex-turn-${Math.floor(NOW / 1000)}-1.json`
  const turnBody = JSON.stringify({ 'thread-id': 'zzzz0000', cwd: '/tmp/api-gateway', 'last-assistant-message': 'Should I continue with the rollout?' })
  const result = run([], { inbox: [{ name: turnFile, body: turnBody }] })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '3 need you · 3 working\n')
  assert.equal(result.stderr, '')

  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardText, peekInbox } = await import('../hooks/board.ts')
  const { STRINGS } = await import('../hooks/strings.ts')
  const s = STRINGS.en

  const view = buildView(parseProgress(FILE), [], null, NOW, 0, {}, s)
  const turns = peekInbox([{ name: turnFile, body: turnBody, at: NOW }], () => '', undefined, s)
  assert.equal(turns.length, 1, 'one inbox turn is pending')
  assert.equal(turns[0]?.isQuestion, true, 'the inbox turn asks a question')

  // Page surface, from the same root and the same turns.
  const pageModel = serveModel(view, turns, s, new Set(), false, undefined, false, {
    now: NOW, repoOf: () => null, versions: { board: '', package: null }, unreadable: [],
  })
  assert.equal(pageModel.view.n, 3, 'page needs count matches')
  assert.equal(pageModel.view.working.length, 3, 'page working count matches')

  // Terminal board surface, from the same root and the same turns.
  const terminalText = boardText(view, turns, s, { width: 100, isColor: false })
  const countLine = terminalText.split('\n')[0]
  assert.ok(countLine.includes('● 3 waiting'), `terminal waiting count line: ${countLine}`)
  assert.ok(countLine.includes('▸ 3 in progress'), `terminal active count line: ${countLine}`)
})

test('one count across all three surfaces: page, terminal board and --status match exactly (#832)', async () => {
  const answered = { answered: ['aaaa1111 1 First choice?'] }
  const result = run([], { answered })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '1 need you · 4 working\n')

  const { parseProgress } = await import('../hooks/parse.ts')
  const { buildView, parseAnswered } = await import('../hooks/view.ts')
  const { serveModel } = await import('../hooks/serve.ts')
  const { boardText } = await import('../hooks/board.ts')
  const { STRINGS } = await import('../hooks/strings.ts')
  const s = STRINGS.en

  const parsed = parseProgress(FILE)
  const answeredList = parseAnswered(JSON.stringify(answered)) ?? []
  const view = buildView(parsed, [], null, NOW, 0, {}, s, answeredList)

  // 1. Page surface
  const pageModel = serveModel(view, [], s, new Set(), false, undefined, false, {
    now: NOW, repoOf: () => null, versions: { board: '', package: null }, unreadable: [],
  })
  const pageNeeds = pageModel.view.n
  const pageWorking = pageModel.view.working.length

  // 2. Terminal board surface
  const terminalText = boardText(view, [], s, { width: 100, isColor: false })
  const countLine = terminalText.split('\n')[0]

  // 3. Status surface (already verified 1 need you · 4 working)
  assert.equal(pageNeeds, 1, 'page needs count matches')
  assert.equal(pageWorking, 4, 'page working count matches')
  assert.ok(countLine.includes('● 1 waiting'), `terminal waiting count line: ${countLine}`)
  assert.ok(countLine.includes('▸ 4 in progress'), `terminal active count line: ${countLine}`)
})

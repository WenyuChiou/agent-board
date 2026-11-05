import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(specifier + '.ts', context)
  }
} })
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// The guard runs before the installed bundle: reading anything beyond progress.md and
// its two sidecars (answered, questions), writing, polling or launching anything fails
// the command (#832).
const guard = `import { createRequire as statusCreateRequire } from 'node:module'
{
const require = statusCreateRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { resolve } = require('node:path')
const read = fs.readFileSync
const progressFile = resolve(process.env.STATUS_PROGRESS)
const answeredFile = resolve(process.env.STATUS_PROGRESS.replace(/\\.md$/i, '') + '-answered.json')
const questionsFile = resolve(process.env.STATUS_PROGRESS.replace(/\\.md$/i, '') + '-questions.json')
const reads = { progress: 0, answered: 0, questions: 0 }
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
    return read(file, ...args)
  }
  if (target === questionsFile) {
    reads.questions++
    return read(file, ...args)
  }
  violations.push(String(file))
  throw new Error('only progress.md and its sidecars may be read')
}
const refused = () => { violations.push(new Error().stack); throw new Error('status must not write, inspect other files, poll or start anything') }
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'openSync', 'statSync', 'readdirSync', 'watch', 'watchFile']) fs[name] = refused
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
})
}
`

const run = (args = [], { file = FILE, answered = null, questions = null, lang = 'en', denied = false, launcher = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-status-'))
  try {
    const path = join(root, 'progress.md')
    if (file !== null) writeFileSync(path, file)
    if (answered !== null) writeFileSync(join(root, 'progress-answered.json'), typeof answered === 'string' ? answered : JSON.stringify(answered))
    if (questions !== null) writeFileSync(join(root, 'progress-questions.json'), typeof questions === 'string' ? questions : JSON.stringify(questions))
    const script = join(root, 'agent-board.mjs')
    writeFileSync(script, `${guard}\nglobalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const before = readdirSync(root).sort()
    const command = launcher ? [fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url)), '--progress-file', path] : [script]
    const result = spawnSync(process.execPath, [...command, '--status', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: root, CLAUDE_PROGRESS_FILE: '', XDG_CONFIG_HOME: root, XDG_RUNTIME_DIR: root, LOCALAPPDATA: root, APPDATA: root, HERMES_HOME: root, OPENCLAW_STATE_DIR: root, OPENCODE_CONFIG_DIR: root, DSH_HOME: root, GROK_HOME: root, STATUS_PROGRESS: path, STATUS_DENIED: denied ? '1' : '', NO_COLOR: undefined, FORCE_COLOR: '3' },
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

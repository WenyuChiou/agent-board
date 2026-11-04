import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const loadSources = async () => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      return nextResolve(specifier, context)
    },
  })
  try {
    return await Promise.all([import('../hooks/board-json.ts'), import('../hooks/serve.ts'), import('../hooks/view.ts'), import('../hooks/parse.ts'), import('../hooks/strings.ts'), import('../hooks/board.ts')])
  } finally { loader.deregister() }
}

const [{ BOARD_JSON_SCHEMA, boardDocument }, { serveModel }, { buildView }, { parseProgress }, { STRINGS }, { clipped, plain, redact }] = await loadSources()
const NOW = Date.parse('2026-11-04T12:00:00Z')
const MINUTE = 60_000
const block = (id, agent, state, title, steps, at = NOW) => `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(at).toISOString()} -->
### ${title}
${steps}
<!-- /auto session=${id} -->
`
const progress = (now = NOW) => `## synthetic-api
${block('a1000001', 'codex', 'waiting', 'Choose the limit', '- [?] Limit — 100 or 300 a minute?', now - MINUTE)}
${block('a1000002', 'cursor', 'working', 'Restore the config', '- [!] Config is missing — Need the sample file', now - 2 * MINUTE)}
${block('a1000003', 'opencode', 'working', 'Check endpoints', '- [x] Read the route list\n- [~] Compare responses', now - 4 * MINUTE)}
${block('a1000004', 'codex', 'waiting', 'Wait for CI', '- [>] Waiting for CI', now - 31 * MINUTE)}
${block('a1000005', 'cursor', 'ended', 'Stopped investigation', '- [ ] Read the next log', now - 2 * 60 * MINUTE)}
${block('a1000006', 'opencode', 'done', 'Fixed the links', '- [x] Checked every link', now - 10 * MINUTE)}
${block('a1000007', 'codex', 'done', 'Earlier completed task', '- [x] Checked the fixture', now - 2 * 24 * 60 * MINUTE)}
## personal
### Undated task
- [ ] Read the proposal
`
const groupOptions = (now = NOW, repoOf = () => null) => ({ now, repoOf, versions: { board: '0.0.0', package: null }, unreadable: [] })
const viewOf = (source = progress(), s = STRINGS.en, now = NOW) => buildView(parseProgress(source), [], null, now, 0, {}, s)
const documentOf = (view, s = STRINGS.en, group = groupOptions()) => boardDocument(view, [], ['synthetic-api · Reviewed the fixture'], s, '/synthetic-home', false, NOW, group)

test('the board document has a schema version, the questions that need the person, and working, waiting and done rows', () => {
  const view = { ...viewOf(), warning: 'Synthetic warning', details: 'Synthetic details' }
  const before = structuredClone(view)
  const document = documentOf(view)
  assert.equal(BOARD_JSON_SCHEMA, 1)
  assert.equal(document.schemaVersion, 1)
  assert.equal(document.generatedAt, new Date(NOW).toISOString())
  assert.equal(document.lang, 'en')
  assert.deepEqual(document.counts, { needs: 2, questions: 1, stuck: 1, working: 1, waiting: 2, stopped: 1, doneRecently: 2 })
  assert.deepEqual(document.needs.map(one => one.kind), ['question', 'stuck'])
  assert.deepEqual(document.needs[0].options, ['100', '300 a minute'])
  assert.equal(document.needs[0].askedAt, new Date(NOW - MINUTE).toISOString())
  assert.equal(document.needs[1].note, 'Need the sample file')
  assert.deepEqual(document.working[0], {
    agent: 'opencode', project: 'synthetic-api', title: 'Check endpoints', step: 'Compare responses',
    done: 1, total: 2, updatedAt: new Date(NOW - 4 * MINUTE).toISOString(), age: '4 min ago', isUnsure: false,
  })
  assert.equal(document.waiting.find(one => one.title === 'Wait for CI').isUnsure, false)
  const unknown = document.waiting.find(one => one.title === 'Undated task')
  assert.equal(unknown.updatedAt, null)
  assert.equal(unknown.age, STRINGS.en.pgUnknownAge)
  assert.equal(unknown.isUnsure, true)
  assert.equal(document.stopped[0].title, 'Stopped investigation')
  assert.deepEqual(document.doneRecently.map(one => one.title), ['Fixed the links', 'Earlier completed task'])
  assert.deepEqual(document.doneToday, ['synthetic-api · Reviewed the fixture'])
  assert.deepEqual(document.notices, ['Synthetic warning', 'Synthetic details'])
  assert.deepEqual(view, before, 'serializing does not mutate its input')
  const fallback = boardDocument(view, [], [], STRINGS.en, '', false, NOW)
  assert.equal(fallback.counts.needs, serveModel(view, [], STRINGS.en).asks.length)
  assert.deepEqual(fallback.working, document.working)
  for (const s of Object.values(STRINGS)) {
    const future = documentOf(viewOf(`## synthetic\n${block('a1000008', 'codex', 'working', 'Future clock', '- [~] Check the clock', NOW + 60 * MINUTE)}`, s), s)
    assert.equal(future.working[0].isUnsure, true)
    assert.equal(future.working[0].age, s.futureTimeUnknown)
    assert.equal(future.lang, s.lang)
    assert.ok(s.boardUsage.includes('--json') && s.boardUsageAll.includes('[--json]'))
    assert.ok(s.boardUsage.includes('--chat') && s.boardUsageAll.includes('[--chat]'))
  }
})

test('the board document hides the home folder and known credential forms, as the chat board does', () => {
  const home = 'C:\\Users\\Jane Doe'
  const credentials = 'key=short-value token: ghp_abc123 password: hunter2 key: abcdef0123456789abcdef0123456789 key: hunter3 2FA token: 482913'
  const token = ['ghp', '16C7e42F292c6912E7710c838347Ae178B4a'].join('_')
  const secrets = `${credentials} OPENAI_API_KEY=sk-test1234567890abcdef Bearer abcDEF123 Basic dXNlcjpwYXNz https://ci.example.com/run?t=abc123&page=2 postgres://app:${'x'.repeat(100)}/K7MDENG@dbhost ${token}`
  const view = viewOf(`## jane doe\n${block('a1000010', 'codex', 'working', `Read ${home}\\notes.md`, `- [~] Open ${home}\\site\\links.md and set ${secrets}`)}`)
  const original = view.groups[0].rows[0]
  const text = `Use ${home}\\notes.md with ${secrets}`
  const long = `Long ${'readable words '.repeat(45)} ${home}\\private`
  const synthetic = {
    ...view,
    warning: text,
    details: long,
    waiting: [{ ...viewOf().waiting[0], project: 'JANE DOE', agent: text, task: text, text: `Use ghp_ab\u0001c123 ${home}\\file`, note: text, kind: 'choose', options: [text, 'Keep token: budget and key: 100'], at: NOW }],
    groups: [{ project: 'jane doe', rows: [{ ...original, title: text, steps: [{ ...original.steps[0], text }], agent: 'codex' }] }],
  }
  const document = boardDocument(synthetic, [], [text], STRINGS.en, home, true, NOW, groupOptions())
  const output = JSON.stringify(document)
  for (const secret of ['Jane Doe', 'jane doe', 'JANE DOE', 'short-value', 'ghp_abc123', 'hunter2', 'abcdef0123456789abcdef0123456789', 'hunter3', '482913', 'sk-test', 'abc123', 'abcDEF123', 'dXNlcjpwYXNz', 'K7MDENG', token.slice(4, 14), 'xxxx']) assert.ok(!output.includes(secret), secret)
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(document.needs[0].text))
  assert.equal(document.needs[0].project, '~')
  assert.equal(document.working[0].project, '~')
  assert.equal(document.doneToday[0], redact(clipped(plain(text), home, true), home, true))
  assert.equal(document.notices[1], redact(clipped(plain(long), home, true), home, true))
  assert.ok(document.notices[1].length > 200, 'JSON does not fit text to a terminal column')
  assert.ok(document.needs[0].options.includes('Keep token: budget and key: 100'))
  assert.ok(document.doneToday[0].includes('https://ci.example.com/run?page=2'))
  const inspect = value => {
    if (Array.isArray(value)) value.forEach(inspect)
    else if (value && typeof value === 'object') for (const [key, part] of Object.entries(value)) {
      assert.ok(!['fp', 'session', 'sessionId', 'dir', 'resume', 'send', 'routes', 'token'].includes(key), key)
      inspect(part)
    }
  }
  inspect(document)
})

test('the board document and the page give the same Needs-you count and cards for one board', () => {
  for (const s of Object.values(STRINGS)) {
    const base = viewOf(progress(), s)
    const groups = base.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, dir: '/synthetic/worktrees/branch' })) }))
    const view = { ...base, groups, waiting: [...base.waiting, base.waiting[0]] }
    const options = groupOptions(NOW, () => 'synthetic-repository')
    const pending = [{ agent: 'openclaw', project: 'synthetic-inbox', text: 'Review this fixture?', isQuestion: true, at: NOW }]
    const model = serveModel(view, pending, s, new Set(), false, undefined, false, options)
    const document = boardDocument(view, pending, [], s, '', false, NOW, options)
    assert.equal(document.counts.needs, model.view.needs.cards.length)
    assert.equal(document.counts.questions, model.view.needs.questions)
    assert.equal(document.counts.stuck, model.view.needs.stuck)
    assert.deepEqual(document.needs.map(one => [one.kind, one.agent, one.project]), model.view.needs.cards.map(one => [one.kind, one.agent, one.repo]))
    for (const [index, ref] of model.view.needs.cards.entries()) {
      const source = [...model.asks, ...model.turns, ...model.groups.flatMap(group => group.rows)].find(one => one.key === ref.key.replace(/^stuck:/, ''))
      assert.equal(document.needs[index].text, ref.kind === 'stuck' ? source.title : source.text)
      assert.deepEqual(document.needs[index].options, source.answers ?? [])
    }
    assert.deepEqual(document.working.map(one => [one.agent, one.project]), model.view.working.map(one => [one.agent, one.repo]))
    const working = new Set(model.view.working.map(one => one.key))
    assert.equal(document.waiting.length, [...model.view.all.open, ...model.view.own.open].filter(one => !working.has(one.key)).length)
    assert.equal(document.stopped.length, model.view.all.stopped.length + model.view.own.stopped.length)
    assert.equal(document.doneRecently.length, model.view.all.done.length + model.view.own.done.length)
  }
})

const snapshot = root => {
  const entries = []
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const relative = join(prefix, name)
      const stat = statSync(path)
      entries.push(stat.isDirectory() ? [relative, 'directory'] : [relative, stat.mtimeMs, createHash('sha256').update(readFileSync(path)).digest('hex')])
      if (stat.isDirectory()) visit(path, relative)
    }
  }
  visit(root)
  return entries
}

const jsonRun = (args, { isFolder = false, lang = 'en', hasClockFailure = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'))
  try {
    const home = join(root, 'Jane Doe')
    const dirs = Object.fromEntries(['.claude', 'local', 'roaming', 'config', 'data', 'state', 'cache', 'run'].map(name => [name, join(home, name)]))
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    const path = join(dirs['.claude'], 'progress.md')
    if (isFolder) mkdirSync(path)
    else writeFileSync(path, progress(Date.now()).replace('Compare responses', `Open ${home} and set OPENAI_API_KEY=sk-test1234567890abcdef`))
    for (const [name, text] of Object.entries({ 'progress-seen.json': '{"seen":{}}', 'progress-questions.json': '{', 'progress-questions-retired-synthetic.json': '{' })) writeFileSync(join(dirs['.claude'], name), text)
    const script = join(dirs['.claude'], 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const prelude = join(root, 'read-only.cjs')
    writeFileSync(prelude, `const fs = require('node:fs')
const cp = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const attempts = []
const refuse = name => (...args) => { attempts.push(name); throw new Error('unexpected side effect: ' + name) }
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'linkSync', 'chmodSync', 'rmSync']) fs[name] = refuse(name)
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = refuse(name)
http.createServer = refuse('http.createServer')
net.createServer = refuse('net.createServer')
require('node:module').syncBuiltinESMExports()
${hasClockFailure ? `Date.now = () => { throw new TypeError('Cannot continue in ' + process.env.HOME + '/notes.md with OPENAI_API_KEY=sk-test1234567890abcdef') }` : ''}
process.on('exit', () => { if (attempts.length) { process.stderr.write(attempts.join(', ')); process.exitCode = 1 } })
`)
    const before = snapshot(root)
    const ran = spawnSync(process.execPath, ['--require', prelude, script, ...args], {
      cwd: home, encoding: 'utf8', timeout: 20_000,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: dirs.local, APPDATA: dirs.roaming,
        XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.run,
        TMPDIR: dirs.run, TEMP: dirs.run, TMP: dirs.run, CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: '', NO_COLOR: '1',
      },
    })
    return { ...ran, home, before, after: snapshot(root) }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('agent-board --json prints one JSON document and writes no file', () => {
  const flags = [[], ['--serve', '--lan'], ['--watch'], ['--html'], ['--keys', 'down x'], ['--tidy'], ['--serve-child'], ['--stop'], ['--status'], ['--help', 'all'], ['--codex-report'], ['--codex-event'], ['--agent-status'], ['--chat', '--serve', '--watch', '--keys', 'down h']]
  for (const extra of flags) {
    const ran = jsonRun(['--json', ...extra])
    assert.equal(ran.status, 0, ran.stderr || ran.stdout)
    assert.equal(ran.stderr, '')
    assert.equal(ran.stdout.trimEnd().split('\n').length, 1)
    assert.ok(ran.stdout.endsWith('\n'))
    const document = JSON.parse(ran.stdout)
    assert.equal(document.schemaVersion, 1)
    assert.ok(document.counts.needs > 0)
    assert.ok(!ran.stdout.includes(ran.home) && !ran.stdout.includes('Jane Doe') && !ran.stdout.includes('sk-test'))
    assert.deepEqual(ran.after, ran.before, extra.join(' '))
  }
})

test('agent-board --json on an unreadable board prints a JSON error and exits 1', () => {
  for (const lang of Object.keys(STRINGS)) {
    const ran = jsonRun(['--json', '--serve'], { isFolder: true, lang })
    assert.equal(ran.status, 1, ran.stderr || ran.stdout)
    assert.equal(ran.stderr, '')
    assert.equal(ran.stdout.trimEnd().split('\n').length, 1)
    const document = JSON.parse(ran.stdout)
    assert.deepEqual(Object.keys(document), ['schemaVersion', 'error'])
    assert.equal(document.schemaVersion, 1)
    assert.ok(document.error.includes(STRINGS[lang].fileProgress))
    assert.ok(document.error.includes(STRINGS[lang].storageIsFolder))
    assert.ok(!ran.stdout.includes(ran.home) && !ran.stdout.includes('Jane Doe') && !/\n\s+at |node:internal|Error:/.test(ran.stdout))
    assert.deepEqual(ran.after, ran.before)
  }
  const failed = jsonRun(['--json'], { hasClockFailure: true })
  assert.equal(failed.status, 1, failed.stderr || failed.stdout)
  assert.equal(failed.stderr, '')
  const failure = JSON.parse(failed.stdout)
  assert.deepEqual(Object.keys(failure), ['schemaVersion', 'error'])
  assert.equal(failure.schemaVersion, 1)
  assert.ok(failure.error.startsWith('The board could not be shown (Cannot continue in ~/notes.md with OPENAI_API_KEY=•••'), failed.stdout)
  assert.ok(!failed.stdout.includes(failed.home) && !failed.stdout.includes('sk-test') && !failed.stdout.includes('Jane Doe'))
  assert.deepEqual(failed.after, failed.before)
})

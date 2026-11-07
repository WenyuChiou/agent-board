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

const [{ BOARD_JSON_SCHEMA, boardDocument, collectFinished }, { serveModel }, { buildView }, { parseProgress }, { STRINGS }, { clipped, plain, redact }] = await loadSources()
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
    assert.ok(s.boardUsageAll.includes('[--print]'))
    assert.ok(!s.boardUsage.includes('--chat') && !s.boardUsageAll.includes('--chat'))
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

const jsonRun = (args, { isFolder = false, lang = 'en', hasClockFailure = false, files = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-json-'))
  try {
    const home = join(root, 'Jane Doe')
    const dirs = Object.fromEntries(['.claude', 'local', 'roaming', 'config', 'data', 'state', 'cache', 'run'].map(name => [name, join(home, name)]))
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    const path = join(dirs['.claude'], 'progress.md')
    if (isFolder) mkdirSync(path)
    else writeFileSync(path, progress(Date.now()).replace('Compare responses', `Open ${home} and set OPENAI_API_KEY=sk-test1234567890abcdef`))
    for (const [name, text] of Object.entries({ 'progress-seen.json': '{"seen":{}}', 'progress-questions.json': '{', 'progress-questions-retired-synthetic.json': '{', ...files })) writeFileSync(join(dirs['.claude'], name), text)
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

test('#224 a blocked step shows beside an open question on the same task: the question card stays and the stuck row appears', () => {
  const source = `## synthetic-api
${block('a2000001', 'codex', 'waiting', 'Synthetic card', '- [x] Synthetic step finished\n- [?] Synthetic ask: blue or green?\n- [!] Synthetic blocker: waiting on a fake license key', NOW - MINUTE)}`
  const view = viewOf(source)
  assert.equal(view.waiting.length, 1, 'the question still has its card')
  const rows = view.groups.flatMap(group => group.rows)
  assert.equal(rows.length, 1, 'the task keeps its row under the project')
  assert.match(rows[0].status, /fake license key/)
  assert.equal(rows[0].tone, 'alert')
  const document = documentOf(view)
  assert.deepEqual(document.needs.map(one => one.kind).sort(), ['question', 'stuck'])
  assert.equal(document.counts.stuck, 1)
  assert.match(JSON.stringify(document), /fake license key/)
})

test('#224 the page model and --json agree on a task that asks and is stuck, in every language', () => {
  const source = `## synthetic-api
${block('a2000002', 'codex', 'waiting', 'Synthetic card', '- [?] Synthetic ask: blue or green?\n- [!] Synthetic blocker: waiting on a fake license key', NOW - MINUTE)}`
  for (const s of Object.values(STRINGS)) {
    const view = viewOf(source, s)
    const model = serveModel(view, [], s, new Set(), false, undefined, false, groupOptions())
    assert.equal(model.view.needs.stuck, 1)
    assert.equal(model.view.needs.questions, 1)
    assert.equal(model.groups.flatMap(group => group.rows).length, 1)
    assert.match(model.groups[0].rows[0].status, /fake license key/)
    assert.equal(boardDocument(view, [], [], s, '', false, NOW, groupOptions()).counts.stuck, 1)
  }
})

test('#997 a working session with an open question and a blocked step shows the blocker on its row, on the page model and in --json', () => {
  const source = `## synthetic-api
${block('a9970001', 'cursor', 'working', 'Synthetic card', '- [?] Synthetic ask: blue or green?\n- [!] Synthetic blocker: waiting on a fake license key', NOW - MINUTE)}`
  for (const s of Object.values(STRINGS)) {
    const view = viewOf(source, s)
    const row = view.groups.flatMap(group => group.rows)[0]
    assert.match(row.status, /fake license key/)
    assert.equal(row.tone, 'alert')
    const model = serveModel(view, [], s, new Set(), false, undefined, false, groupOptions())
    assert.match(model.groups[0].rows[0].status, /fake license key/)
    assert.equal(boardDocument(view, [], [], s, '', false, NOW, groupOptions()).counts.stuck, 1)
  }
})

test('#997 an ended session keeps its ended phrase: a blocked step on a stopped session is not a live request', () => {
  const source = `## synthetic-api
${block('a9970002', 'cursor', 'ended', 'Synthetic card', '- [?] Synthetic ask: blue or green?\n- [!] Synthetic blocker: waiting on a fake license key', NOW - MINUTE)}`
  const view = viewOf(source)
  const row = view.stopped[0]
  assert.doesNotMatch(row.status, /fake license key/)
  const document = boardDocument(view, [], [], STRINGS.en, '', false, NOW, groupOptions())
  assert.equal(document.counts.stuck, 0)
  assert.ok(!document.needs.some(one => one.kind === 'stuck'))
})

test('collectFinished pure function collects finished tasks from journal within N days', () => {
  const journalText = `- 2026-11-03 14:00 · synthetic-api · Shipped the auth endpoint · Added unit tests
- 2026-11-01 10:00 · synthetic-api · Added database migrations · Ran migrate
- 2026-10-20 08:00 · old-project · Outdated task · Done long ago
`
  const source = progress(NOW)
  const finished = collectFinished(source, [journalText], [], 7, NOW, undefined, '/synthetic-home', false)
  assert.ok(finished.length >= 2)
  const auth = finished.find(t => t.title === 'Shipped the auth endpoint')
  assert.ok(auth)
  assert.equal(auth.project, 'synthetic-api')
  assert.equal(auth.agent, '')
  assert.equal(auth.finishedDate, '2026-11-03')
  assert.deepEqual(auth.steps, [{ text: 'Added unit tests', date: '2026-11-03 14:00' }])

  const outdated = finished.find(t => t.title === 'Outdated task')
  assert.equal(outdated, undefined, 'tasks older than 7 days are excluded')

  // Project filter
  const filtered = collectFinished(source, [journalText], [], 7, NOW, 'synthetic-api', '/synthetic-home', false)
  assert.ok(filtered.every(t => t.project === 'synthetic-api'))
})

test('an agent reads the week\'s finished work from the journal without the board text (#1024)', () => {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const month = new Date().toISOString().slice(0, 7)
  const journalName = `progress-journal-${month}.md`
  const journalContent = `- ${yesterday} 14:00 · synthetic-api · Shipped the auth endpoint · Added unit tests\n- ${twoDaysAgo} 10:30 · personal · Archived photo album · Scaled thumbnails\n`

  const ran = jsonRun(['--json', '--days', '7'], { files: { [journalName]: journalContent } })
  assert.equal(ran.status, 0, ran.stderr || ran.stdout)
  assert.equal(ran.stderr, '')
  assert.equal(ran.stdout.trimEnd().split('\n').length, 1)
  assert.ok(ran.stdout.endsWith('\n'))
  assert.ok(!ran.stdout.includes('Updates every 2 seconds'))
  assert.ok(!ran.stdout.includes('needs you ·'))

  const document = JSON.parse(ran.stdout)
  assert.equal(document.schemaVersion, 1)
  assert.ok(Array.isArray(document.finished))
  const auth = document.finished.find(t => t.title === 'Shipped the auth endpoint')
  assert.ok(auth)
  assert.equal(auth.project, 'synthetic-api')
  assert.equal(auth.agent, '')
  assert.equal(auth.finishedDate, yesterday)
  assert.deepEqual(auth.steps, [{ text: 'Added unit tests', date: `${yesterday} 14:00` }])
})

test('a journal step ending in a word in brackets keeps its words and names no agent (#1052)', () => {
  // A journal line is date · project · task · step; nothing in it names an agent (docs/FORMAT.md).
  const journalText = `- 2026-11-03 14:00 · synthetic-api · Ship the build · Deploy (Windows)\n`
  const finished = collectFinished('', [journalText], [], 7, NOW, undefined, '/synthetic-home', false)
  const ship = finished.find(t => t.title === 'Ship the build')
  assert.ok(ship)
  assert.equal(ship.agent, '')
  assert.deepEqual(ship.steps, [{ text: 'Deploy (Windows)', date: '2026-11-03 14:00' }])
})

test('--days 0 or a bad value is refused with the usage line (#1024)', () => {
  const badArgs = [
    ['--json', '--days', '0'],
    ['--json', '--days', '-1'],
    ['--json', '--days', '91'],
    ['--json', '--days', 'invalid'],
    ['--json', '--days', '3.14'],
  ]
  for (const args of badArgs) {
    const ran = jsonRun(args)
    assert.equal(ran.status, 1, `expected status 1 for ${args.join(' ')}`)
    assert.ok(ran.stderr.includes(STRINGS.en.boardUsage), `stderr should contain usage line: ${ran.stderr}`)
  }
})

test('--project narrows the finished work to that project\'s heading (#1024)', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const month = new Date().toISOString().slice(0, 7)
  const journalName = `progress-journal-${month}.md`
  const journalContent = `- ${yesterday} 14:00 · synthetic-api · Shipped the auth endpoint · Added unit tests\n- ${twoDaysAgo} 10:30 · personal · Archived photo album · Scaled thumbnails\n`

  const ran = jsonRun(['--json', '--days', '7', '--project', 'synthetic-api'], { files: { [journalName]: journalContent } })
  assert.equal(ran.status, 0, ran.stderr || ran.stdout)
  assert.equal(ran.stderr, '')
  const document = JSON.parse(ran.stdout)
  assert.ok(Array.isArray(document.finished))
  assert.ok(document.finished.length > 0)
  assert.ok(document.finished.every(t => t.project === 'synthetic-api'))
  assert.ok(!document.finished.some(t => t.project === 'personal'))
})

test('collectFinished collects finished tasks from archives using heading date and preserves auto agent (#1024)', () => {
  const archiveText = `## synthetic-api · 2026-11-02
<!-- auto session=a3000001 agent=codex state=done updated=2026-11-02T10:00:00.000Z -->
### Database refactor
- [x] Migrated schemas
<!-- /auto session=a3000001 -->
`
  const finished = collectFinished('', [], [archiveText], 7, NOW, undefined, '/synthetic-home', false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].title, 'Database refactor')
  assert.equal(finished[0].project, 'synthetic-api')
  assert.equal(finished[0].agent, 'codex')
  assert.equal(finished[0].finishedDate, '2026-11-02')
  assert.deepEqual(finished[0].steps, [{ text: 'Migrated schemas', date: '2026-11-02' }])
})

test('undated manual completed tasks in progress.md are not fabricated as today (#1024)', () => {
  const manualUndated = `## synthetic-api
### Old manual task without stamp
- [x] Finished without stamp
`
  const finished = collectFinished(manualUndated, [], [], 1, NOW, undefined, '/synthetic-home', false)
  assert.equal(finished.length, 0, 'undated tasks should not be fabricated as today')
})

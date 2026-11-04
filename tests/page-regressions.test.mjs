import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { pageFixture as fixture } from './page-reader-fixture.mjs'
import { pageDom } from './e2e/lib/surfaces.mjs'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const livePage = await import('../hooks/live-page.ts')
const { liveBoardArgv, liveBoardPage, pageStatePath } = livePage
const { keepInboxDone, isInboxFile } = await import('../hooks/inbox.ts')
const { addPruned, sizeWarnings, storageDetails, prunedNote } = await import('../hooks/retention.ts')
const { turnsFor, redact } = await import('../hooks/board.ts')
const { countManualDone, cutBlockLines } = await import('../hooks/blocks.ts')
const { handKeptSeenAt } = await import('../hooks/view.ts')
const { sha256 } = await import('../hooks/sha256.ts')
const { psQuote } = await import('../hooks/connect.ts')
const { EN } = await import('../hooks/strings-en.ts')
const NOW = Date.parse('2026-11-04T12:00:00Z')
const NAME = 'codex-turn-1793793600000-1.json'
const turn = answer => JSON.stringify({ session_id: 'synthetic-turn', cwd: '/work/demo', prompt: 'Private prompt contents /home/demo/private', last_assistant_message: answer })

// A board script run here must read its fixture, not a progress file named by the caller's environment (preflight sets one).
const readerEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'CLAUDE_PROGRESS_FILE'))

// Execute the plugin's production functions in separate session contexts, without starting a host.
const publisher = () => {
  const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const extract = (begin, end) => {
    const start = source.indexOf(begin)
    const stop = source.indexOf(end, start)
    assert.ok(start >= 0 && stop > start, begin)
    return source.slice(start, stop)
  }
  const selected = [
    'const REWRITE_TRIES = 3; const AGAIN = Symbol("again"); let measuredStore = 0; let measuredPruned = { agent: 0, mirror: 0, turns: 0 }; let pendingCache = null; let pageStateFailure = null; let publishedPageDone = null; let publishedPageState = null; const verifiedPageDone = new Set(); let questionWrite = 0;',
    extract('const PRUNED_PER_SWEEP =', '\n'),
    extract('const readText =', '\n\n// Every write this session'),
    extract('const removeFiles =', '\n\n// A rename either'),
    extract('const replaceFile =', '\n\ntype Completion'),
    extract('const rewrite = async', "\n\n// This session's block"),
    extract('const readInboxRecord =', '\n\nconst writeInboxRecord ='),
    extract('const syncPageState =', '\n\n// The moment a view'),
    extract('const pendingTurns =', '\n\nconst views ='),
    extract('const warningOf =', '\n\nlet isInteractiveSession'),
    extract('const inboxFailure =', '\n\n// A claim can expire'),
    extract('const stalePageDone =', '\n\n// When each inbox file'),
  ].join('\n')
  return new Function('d', `const { pageStatePath, pageDonePath, pageDoneHash, readPageDone, readPageState, keepInboxDone, addPruned, progressPath, inboxPath, turnsFor, wordsOf, isInboxFile, sepOf, redact, isWindows, sha256, psQuote, sizeWarnings, storageDetails, prunedNote, countManualDone, cutBlockLines, handKeptSeenAt, messageOf } = d;\n${stripTypeScriptTypes(selected)}\nreturn { syncPageState, pendingTurns, stalePageDone, warning: () => warningOf({ size: 0, projects: [] }, d.s, {}, d.at).warning }`)({
    ...livePage, keepInboxDone, addPruned, turnsFor, redact, isInboxFile, sha256, psQuote,
    sizeWarnings, storageDetails, prunedNote, countManualDone, cutBlockLines, handKeptSeenAt,
    progressPath: async engine => engine.taskPath,
    inboxPath: path => join(dirname(path), 'progress-inbox'),
    sepOf: path => path.includes('\\') ? '\\' : '/',
    wordsOf: async () => EN,
    isWindows: async () => process.platform === 'win32',
    messageOf: error => error instanceof Error ? error.message : String(error),
    s: EN, at: NOW,
  })
}
const publishingEngine = (f, { beforeWrite = async () => {}, isDenied = () => false } = {}) => ({
  taskPath: f.path,
  clock: { now: async () => NOW },
  session: { id: async () => 'synthetic-publisher' },
  process: { run: async (argv, options) => {
    const ran = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: options.timeoutMs, windowsHide: true })
    return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
  } },
  env: { get: async name => ['USERPROFILE', 'HOME'].includes(name) ? '/home/demo' : undefined },
  store: { get: async () => ({}) },
  fs: {
    read: async path => readFileSync(path, 'utf8'),
    exists: async path => { try { statSync(path); return true } catch { return false } },
    write: async (path, text) => {
      assert.ok(resolve(path).startsWith(resolve(f.root) + sep))
      if (isDenied()) throw Object.assign(new Error('EACCES: synthetic publication denied'), { code: 'EACCES' })
      await beforeWrite(path, text)
      writeFileSync(path, text)
    },
    list: async dir => readdirSync(dir).map(name => {
      const stat = statSync(join(dir, name))
      return { name, kind: stat.isFile() ? 'file' : 'directory', mtimeMs: stat.mtimeMs, size: stat.size }
    }),
  },
})

test('a delayed page-state publisher cannot erase another session’s processed inbox acknowledgement', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') }, { version: 1, inboxDone: {}, store: 0, pruned: {} })
  let release, reached, stale
  const held = new Promise(done => { release = done })
  const waiting = new Promise(done => { reached = done })
  try {
    stale = publisher().syncPageState(publishingEngine(f, { beforeWrite: async file => {
      if (file === pageStatePath(f.path)) { reached(); await held }
    } }), {})
    await waiting
    await publisher().syncPageState(publishingEngine(f), { [NAME]: `synthetic:${NOW}` })
    assert.equal((await f.api()).counts.waiting, 0)
    release()
    await stale
    assert.equal((await f.api()).counts.waiting, 0)
    assert.deepEqual(f.runtime.pending(), [])
    writeFileSync(join(f.root, 'fresh-reader.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const fresh = spawnSync(process.execPath, [join(f.root, 'fresh-reader.mjs'), '--json'], { encoding: 'utf8', timeout: 10000, env: readerEnv() })
    assert.equal(fresh.status, 0, fresh.stderr)
    assert.equal(JSON.parse(fresh.stdout).counts.needs, 0)
  } finally {
    release()
    await stale
    await f.close()
  }
})

test('a fresh page and JSON reader keep valid receipts beside a partial receipt and retry its validation', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') })
  const otherName = 'codex-turn-1793793600000-2.json'
  const receipt = name => JSON.stringify({ version: 1, name, stamp: `synthetic:${NOW}` })
  const valid = receipt(NAME)
  const partial = receipt(otherName)
  const partialFile = livePage.pageDonePath(f.path, sha256(partial))
  try {
    writeFileSync(livePage.pageDonePath(f.path, sha256(valid)), valid)
    writeFileSync(partialFile, partial.slice(0, 20))
    assert.equal((await f.api()).counts.waiting, 0)
    writeFileSync(join(f.root, 'fresh-reader.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const fresh = spawnSync(process.execPath, [join(f.root, 'fresh-reader.mjs'), '--json'], { encoding: 'utf8', timeout: 10000, env: readerEnv() })
    assert.equal(fresh.status, 0, fresh.stderr)
    assert.equal(JSON.parse(fresh.stdout).counts.needs, 0)
    writeFileSync(join(f.root, 'progress-inbox', otherName), turn('Publish the other synthetic build?'))
    assert.equal((await f.api()).counts.waiting, 1)
    writeFileSync(partialFile, partial)
    assert.equal((await f.api()).counts.waiting, 0)
  } finally { await f.close() }
})

test('page-state receipts become visible only after their temporary write is complete', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') })
  const text = JSON.stringify({ version: 1, name: NAME, stamp: `synthetic:${NOW}` })
  const final = livePage.pageDonePath(f.path, sha256(text))
  let temporary
  try {
    const production = publisher()
    await production.syncPageState(publishingEngine(f, { beforeWrite: async (file, content) => {
      if (content !== text) return
      temporary = file
      writeFileSync(file, content.slice(0, 20))
      assert.equal(dirname(file), dirname(final))
      assert.equal(existsSync(final), false, 'a partial receipt must stay outside its final path')
      assert.equal((await f.api()).counts.waiting, 1)
    } }), { [NAME]: `synthetic:${NOW}` })
    assert.equal(production.warning(), undefined)
    assert.ok(temporary && temporary !== final)
    assert.equal(existsSync(temporary), false)
    assert.equal(readFileSync(final, 'utf8'), text)
    assert.equal((await f.api()).counts.waiting, 0)
  } finally { await f.close() }
})

test('the page and JSON keep completions five minutes and two days old on the same Done shelf', async () => {
  const block = (id, title, at) => `<!-- auto session=${id} agent=codex state=done updated=${new Date(at).toISOString()} -->\n### ${title}\n- [x] Checked the fixture\n<!-- /auto session=${id} -->\n`
  const titles = ['Five minutes old', 'Two days old']
  const f = await fixture(`## demo\n${block('a1000001', titles[0], NOW - 5 * 60000)}${block('a1000002', titles[1], NOW - 2 * 24 * 60 * 60000)}`)
  try {
    const model = await f.api()
    const refs = [...model.view.all.done, ...model.view.own.done]
    assert.equal(refs.length, 2)
    assert.deepEqual(refs.map(ref => model.finished.find(one => one.key === ref.key).title).sort(), [...titles].sort())
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    for (const title of titles) assert.ok(dom.node('board').readText.includes(title))
    writeFileSync(join(f.root, 'fresh-reader.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    writeFileSync(join(f.root, 'clock.cjs'), `Date.now = () => ${NOW}\n`)
    const fresh = spawnSync(process.execPath, ['--require', join(f.root, 'clock.cjs'), join(f.root, 'fresh-reader.mjs'), '--json'], { encoding: 'utf8', timeout: 10000, env: readerEnv() })
    assert.equal(fresh.status, 0, fresh.stderr)
    const document = JSON.parse(fresh.stdout)
    assert.equal(document.counts.doneRecently, 2)
    assert.deepEqual(document.doneRecently.map(one => one.title), titles)
  } finally { await f.close() }
})

test('a refused page-state publication still returns pending questions and reports a recoverable warning', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') })
  let denied = true
  try {
    const production = publisher()
    const engine = publishingEngine(f, { isDenied: () => denied })
    const pending = await production.pendingTurns(engine)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].isQuestion, true)
    assert.equal(pending[0].text, 'Publish the synthetic build?')
    assert.match(production.warning(), /EACCES/)
    denied = false
    assert.equal((await production.pendingTurns(engine)).length, 1)
    assert.equal(production.warning(), undefined)
  } finally { await f.close() }
})

test('immutable page acknowledgements validate their contents and sweep only expired receipts', async () => {
  const f = await fixture()
  try {
    const receipt = stamp => JSON.stringify({ version: 1, name: NAME, stamp })
    const expired = receipt(`synthetic:${NOW - 4 * 24 * 60 * 60 * 1000}`)
    const recent = receipt(`synthetic:${NOW}`)
    const oldFile = livePage.pageDonePath(f.path, sha256(expired))
    const keptFile = livePage.pageDonePath(f.path, sha256(recent))
    writeFileSync(oldFile, expired)
    writeFileSync(keptFile, recent)
    assert.equal(livePage.readPageDone(expired, sha256(recent)), null)
    const invalid = JSON.stringify({ version: 1, name: '../foreign.json', stamp: `synthetic:${NOW}` })
    assert.equal(livePage.readPageDone(invalid, sha256(invalid)), null)
    assert.deepEqual(await publisher().stalePageDone(publishingEngine(f), f.path, NOW), [oldFile])
    assert.equal(readFileSync(keptFile, 'utf8'), recent)
  } finally { await f.close() }
})

test('interactive live opens request a browser and keep the printed link fallback', () => {
  assert.equal(liveBoardArgv('/synthetic/agent-board.mjs', 'en', true).includes('--no-open'), false)
  assert.equal(liveBoardArgv('/synthetic/agent-board.mjs', 'en', false).includes('--no-open'), true)
  const url = 'http://127.0.0.1:23456/?t=synthetic'
  assert.deepEqual(liveBoardPage(`${EN.serveAt(url)}\n`, EN), { url, isKept: false })
})

test('the production page API and LAN model omit private non-question inbox text', async () => {
  const secret = `sk-${'a'.repeat(40)}`
  const f = await fixture('', { [NAME]: turn(`Private reply contents /home/demo/private ${secret}.`) })
  try {
    const view = f.runtime.view(undefined, NOW)
    for (const model of [await f.api(), f.runtime.serveModel(view, f.runtime.pending(), EN, new Set(), true)]) {
      assert.deepEqual(model.turns.map(one => [one.agent, one.project]), [['codex', 'demo']])
      assert.doesNotMatch(JSON.stringify(model), /Private prompt|Private reply|\/home\/demo|sk-aaaa/)
    }
  } finally { await f.close() }
})

test('the production page reader excludes processed inbox files from its API counts', async () => {
  const f = await fixture('', { [NAME]: turn('Ship the synthetic patch?') }, { version: 1, at: NOW, inboxDone: { [NAME]: `synthetic:${NOW}` }, store: 0, pruned: {} })
  try {
    const model = await f.api()
    assert.equal(model.counts.waiting, 0)
    assert.deepEqual(model.turns, [])
    assert.deepEqual(f.runtime.pending(), [])
  } finally { await f.close() }
})

test('the production page API and rendered page retain cut-off block notices', async () => {
  const f = await fixture('## demo\n<!-- auto session=abcdef12 agent=codex state=working updated=2026-10-01T00:00:00Z -->\n### Cut-off task\n- [ ] Continue\n')
  try {
    const model = await f.api()
    assert.ok(model.health?.some(line => /cut off when its session crashed/.test(line)), JSON.stringify(model))
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    assert.match(dom.node('board').readText, /Cut-off task/)
    for (const line of model.health) assert.ok(dom.node('board').readText.includes(line))
  } finally { await f.close() }
})

test('the production page API renders the measured store warning and cleared counts', async () => {
  const f = await fixture('', {}, { version: 1, at: NOW, inboxDone: {}, store: 2 * 1024 * 1024, pruned: { '2026-11-04': { agent: 2, mirror: 3 } } })
  try {
    const model = await f.api()
    assert.equal(model.warning, EN.boardLarge)
    assert.ok(model.pruned?.includes(EN.prunedAgents(2)), JSON.stringify(model))
    assert.ok(model.pruned?.includes(EN.prunedSessions(3)), JSON.stringify(model))
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    assert.ok(dom.node('board').readText.includes(model.warning))
    assert.ok(dom.node('board').readText.includes(model.pruned))
  } finally { await f.close() }
})

test('JSON and print clip an untrusted field at six hundred characters', async () => {
  const title = 'Long synthetic field '.repeat(60)
  const f = await fixture(`## demo\n### ${title}\n- [ ] Continue\n`)
  try {
    writeFileSync(join(f.root, 'cli.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    for (const flag of ['--json', '--print']) {
      const ran = spawnSync(process.execPath, [join(f.root, 'cli.mjs'), flag], { encoding: 'utf8', timeout: 10000, env: readerEnv() })
      assert.equal(ran.status, 0, ran.stderr)
      assert.ok(ran.stdout.includes('Long synthetic field'))
      assert.ok(!ran.stdout.includes(title.slice(0, 601)))
      if (flag === '--json') assert.equal(JSON.parse(ran.stdout).waiting[0].title, title.slice(0, 600).replace(/\s*\S*$/, ''))
    }
  } finally { await f.close() }
})

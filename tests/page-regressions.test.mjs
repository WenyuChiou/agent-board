import assert from 'node:assert/strict'
import { existsSync, mkdirSync, renameSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { pageFixture as fixture, PAGE_NOW } from './page-reader-fixture.mjs'
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
const { LEDGER_RENAMES } = await import('../hooks/ledger-move.ts')
const { addPruned, sizeWarnings, storageDetails, prunedNote } = await import('../hooks/retention.ts')
const { turnsFor, redact } = await import('../hooks/board.ts')
const { countManualDone, cutBlockLines } = await import('../hooks/blocks.ts')
const { handKeptSeenAt } = await import('../hooks/view.ts')
const { sha256 } = await import('../hooks/sha256.ts')
const { psQuote } = await import('../hooks/connect.ts')
const { EN } = await import('../hooks/strings-en.ts')
const NOW = PAGE_NOW
const TODAY = new Date(NOW).toISOString().slice(0, 10)
const POLL_MS = 2000
const NAME = `codex-turn-${NOW}-1.json`
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
    'const REWRITE_TRIES = 3; const AGAIN = Symbol("again"); let measuredStore = 0; let measuredPruned = { agent: 0, mirror: 0, turns: 0 }; let pendingCache = null; let pageStateFailure = null; let pageBacklogDueAt = null; let publishedPageDone = null; let publishedPageState = null; const verifiedPageDone = new Set(); let questionWrite = 0; const LEDGER_RENAMES = d.LEDGER_RENAMES;',
    extract('const POLL_MS =', '\n'),
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
  return new Function('d', `const { pageStatePath, pageDonePath, pageDoneHash, readPageDone, readPageState, keepInboxDone, addPruned, progressPath, inboxPath, turnsFor, wordsOf, isInboxFile, sepOf, redact, isWindows, sha256, psQuote, sizeWarnings, storageDetails, prunedNote, countManualDone, cutBlockLines, handKeptSeenAt, messageOf } = d;\n${stripTypeScriptTypes(selected)}\nreturn { syncPageState, pendingTurns, stalePageDone, isVerified: file => verifiedPageDone.has(file), warning: () => warningOf({ size: 0, projects: [] }, d.s, {}, d.at).warning }`)({
    ...livePage, LEDGER_RENAMES, keepInboxDone, addPruned, turnsFor, redact, isInboxFile, sha256, psQuote,
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
const publishingEngine = (f, { beforeWrite = async () => {}, afterWrite = async () => {}, isDenied = () => false, isDropped = () => false, clock = { at: NOW } } = {}) => ({
  taskPath: f.path,
  clock: { now: async () => clock.at, advance: ms => { clock.at += ms } },
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
      if (!isDropped(path)) {
        writeFileSync(path, text)
        await afterWrite(path, text)
      }
    },
    list: async dir => readdirSync(dir).map(name => {
      const stat = statSync(join(dir, name))
      return { name, kind: stat.isFile() ? 'file' : 'directory', mtimeMs: stat.mtimeMs, size: stat.size }
    }),
  },
})

test('a delayed page-state publisher cannot erase another session’s 51 processed inbox acknowledgements', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') }, { version: 1, inboxDone: {}, store: 0, pruned: {} })
  const names = [NAME, ...Array.from({ length: 50 }, (_, n) => `codex-turn-${NOW}-${n + 2}.json`)]
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 50 + n}`]))
  const receipt = name => JSON.stringify({ version: 1, name, stamp: done[name] })
  const fileOf = name => livePage.pageDonePath(f.path, sha256(receipt(name)))
  let release, reached, stale
  const held = new Promise(done => { release = done })
  const waiting = new Promise(done => { reached = done })
  try {
    stale = publisher().syncPageState(publishingEngine(f, { beforeWrite: async file => {
      if (file === pageStatePath(f.path)) { reached(); await held }
    } }), {})
    await waiting
    const production = publisher()
    const engine = publishingEngine(f)
    engine.store.get = async key => key === 'inboxDone' ? done : {}
    await production.syncPageState(engine, done)
    assert.equal(existsSync(fileOf(NAME)), false, 'the oldest receipt waits for the next batch')
    assert.equal(names.filter(name => existsSync(fileOf(name))).length, 50)
    assert.equal((await f.api()).counts.waiting, 0)
    for (let n = 0; n < 3; n++) {
      engine.clock.advance(POLL_MS)
      assert.deepEqual(await production.pendingTurns(engine), [])
    }
    release()
    await stale
    for (const name of names) {
      assert.equal(existsSync(fileOf(name)), true, `unchanged polls must publish ${name}`)
      assert.equal(readFileSync(fileOf(name), 'utf8'), receipt(name))
    }
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

test('a warmed publisher migrates all 51 peer acknowledgements after cleared counts change and then stays idle', async () => {
  const f = await fixture()
  const names = Array.from({ length: 51 }, (_, n) => `codex-turn-${NOW}-${n + 1}.json`)
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 51 + n}`]))
  const receipt = name => JSON.stringify({ version: 1, name, stamp: done[name] })
  const fileOf = name => livePage.pageDonePath(f.path, sha256(receipt(name)))
  let pruned = {}
  try {
    const production = publisher()
    const engine = publishingEngine(f)
    engine.store.get = async key => key === 'prunedCounts' ? pruned : {}
    const pageWork = []
    for (const operation of ['read', 'write', 'exists', 'list']) {
      const perform = engine.fs[operation]
      engine.fs[operation] = async (path, ...args) => {
        if (path === f.root || (operation !== 'list' && dirname(path) === f.root)) pageWork.push([operation, path])
        return perform(path, ...args)
      }
    }
    await production.syncPageState(engine, {})
    assert.equal(production.warning(), undefined)
    const previous = JSON.parse(readFileSync(pageStatePath(f.path), 'utf8'))
    writeFileSync(pageStatePath(f.path), JSON.stringify({ ...previous, inboxDone: done }))
    pruned = { [TODAY]: { agent: 2, mirror: 3 } }
    await production.syncPageState(engine, {})
    assert.equal(names.filter(name => existsSync(fileOf(name))).length, 50)
    assert.equal(existsSync(fileOf(names[0])), false, 'the oldest receipt waits for the next poll')
    for (let n = 0; n < 3; n++) {
      engine.clock.advance(POLL_MS)
      assert.deepEqual(await production.pendingTurns(engine), [])
    }
    for (const name of names) assert.equal(readFileSync(fileOf(name), 'utf8'), receipt(name))
    assert.equal(production.warning(), undefined)
    assert.deepEqual(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')).pruned, pruned)
    pageWork.length = 0
    engine.clock.advance(POLL_MS)
    assert.deepEqual(await production.pendingTurns(engine), [])
    assert.deepEqual(pageWork, [], 'an unchanged poll after draining does no page-state file work')
  } finally { await f.close() }
})

test('five publication calls inside one poll write only one batch of a 60-name backlog', async () => {
  const names = Array.from({ length: 60 }, (_, n) => `codex-turn-${NOW}-${n + 1}.json`)
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 60 + n}`]))
  const receipt = name => JSON.stringify({ version: 1, name, stamp: done[name] })
  const f = await fixture('', {}, { version: 1, inboxDone: done, store: 0, pruned: {} })
  const written = () => names.filter(name => existsSync(livePage.pageDonePath(f.path, sha256(receipt(name))))).length
  try {
    const production = publisher()
    const engine = publishingEngine(f)
    for (let n = 0; n < 5; n++) await production.syncPageState(engine, {})
    assert.equal(written(), 50)
    engine.clock.advance(POLL_MS)
    assert.deepEqual(await production.pendingTurns(engine), [])
    assert.equal(written(), 60)
    for (let n = 0; n < 5; n++) await production.syncPageState(engine, {})
    assert.equal(written(), 60)
    engine.clock.advance(POLL_MS)
    assert.deepEqual(await production.pendingTurns(engine), [])
    assert.equal(written(), 60)
    for (const name of names) assert.equal(readFileSync(livePage.pageDonePath(f.path, sha256(receipt(name))), 'utf8'), receipt(name))
    assert.equal(production.warning(), undefined)
  } finally { await f.close() }
})

test('a batch of 50 receipts starts one rename process, not one per file', async () => {
  const names = Array.from({ length: 50 }, (_, n) => `codex-turn-${NOW}-${n + 1}.json`)
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 50 + n}`]))
  const receipt = name => JSON.stringify({ version: 1, name, stamp: done[name] })
  const f = await fixture('', {}, { version: 1, inboxDone: done, store: 0, pruned: {} })
  try {
    const production = publisher()
    const engine = publishingEngine(f)
    const run = engine.process.run
    const starts = []
    engine.process.run = async (argv, options) => { starts.push(argv.includes(LEDGER_RENAMES) ? 'rename' : argv[0]); return run(argv, options) }
    await production.syncPageState(engine, {})
    assert.equal(production.warning(), undefined)
    // One start for the batch; a CI runner's deeper temp folder may split it in two, never one per file.
    const renames = starts.filter(one => one === 'rename').length
    assert.ok(renames >= 1 && renames <= 2, `rename starts: ${renames}`)
    assert.deepEqual(starts.filter(one => one !== 'rename' && one !== 'node'), [], 'no per-file move command starts')
    for (const name of names) assert.equal(readFileSync(livePage.pageDonePath(f.path, sha256(receipt(name))), 'utf8'), receipt(name))
  } finally { await f.close() }
})

test('when the batch rename process is missing or fails, every receipt is still placed by the per-file move', async () => {
  const names = Array.from({ length: 5 }, (_, n) => `codex-turn-${NOW}-${n + 1}.json`)
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 5 + n}`]))
  const receipt = name => JSON.stringify({ version: 1, name, stamp: done[name] })
  for (const mode of ['missing', 'fails']) {
    const f = await fixture('', {}, { version: 1, inboxDone: done, store: 0, pruned: {} })
    try {
      const production = publisher()
      const engine = publishingEngine(f)
      const run = engine.process.run
      let moves = 0
      // A stand-in for the system's move command keeps the test off a slow PowerShell start.
      engine.process.run = async (argv, options) => {
        if (argv[0] === 'node') {
          if (mode === 'missing') throw new Error('ENOENT: synthetic missing node')
          return { exitCode: 1, stdout: '', stderr: 'synthetic failure' }
        }
        const quoted = [...argv.join(' ').matchAll(/'([^']+)'/g)].map(one => one[1])
        const [from, to] = argv[0] === 'mv' ? argv.slice(-2) : quoted
        if (from === undefined || to === undefined || !argv.join(' ').includes(argv[0] === 'mv' ? 'mv' : 'Move-Item')) return run(argv, options)
        moves += 1
        renameSync(from, to)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      await production.syncPageState(engine, {})
      assert.equal(production.warning(), undefined)
      assert.equal(moves, 5)
      for (const name of names) assert.equal(readFileSync(livePage.pageDonePath(f.path, sha256(receipt(name))), 'utf8'), receipt(name))
    } finally { await f.close() }
  }
})

test('a concurrent successor at the 2000-name cap may replace the oldest acknowledgement without a warning', async () => {
  const names = Array.from({ length: 2000 }, (_, n) => `codex-turn-${NOW}-${n + 1}.json`)
  const done = Object.fromEntries(names.map((name, n) => [name, `synthetic:${NOW - 2000 + n}`]))
  const newer = `codex-turn-${NOW}-2001.json`
  const f = await fixture('', {}, { version: 1, inboxDone: done, store: 4096, pruned: {} })
  let writes = 0
  try {
    for (const [name, stamp] of Object.entries(done)) {
      const text = JSON.stringify({ version: 1, name, stamp })
      writeFileSync(livePage.pageDonePath(f.path, sha256(text)), text)
    }
    const production = publisher()
    const engine = publishingEngine(f, { afterWrite: async (file, text) => {
      if (file !== pageStatePath(f.path)) return
      writes += 1
      const snapshot = JSON.parse(text)
      writeFileSync(file, JSON.stringify({ ...snapshot, inboxDone: keepInboxDone({ ...snapshot.inboxDone, [newer]: `peer:${NOW + 1}` }, NOW) }))
    } })
    await production.syncPageState(engine, {})
    assert.equal(production.warning(), undefined)
    const saved = JSON.parse(readFileSync(pageStatePath(f.path), 'utf8'))
    assert.equal(Object.keys(saved.inboxDone).length, 2000)
    assert.equal(saved.inboxDone[names[0]], undefined)
    assert.equal(saved.inboxDone[newer], `peer:${NOW + 1}`)
    assert.equal(writes, 1, 'the successor must be accepted by the first read-back')
  } finally { await f.close() }
})

test('a concurrent successor may acknowledge the same name with a different stamp without a warning', async () => {
  const f = await fixture()
  const done = { [NAME]: `synthetic:${NOW}` }
  const peerReceipt = JSON.stringify({ version: 1, name: NAME, stamp: `peer:${NOW + 1}` })
  let writes = 0
  try {
    const production = publisher()
    const engine = publishingEngine(f, { afterWrite: async (file, text) => {
      if (file !== pageStatePath(f.path)) return
      writes += 1
      const snapshot = JSON.parse(text)
      writeFileSync(livePage.pageDonePath(f.path, sha256(peerReceipt)), peerReceipt)
      writeFileSync(file, JSON.stringify({ ...snapshot, inboxDone: { ...snapshot.inboxDone, [NAME]: `peer:${NOW + 1}` } }))
    } })
    await production.syncPageState(engine, done)
    assert.equal(production.warning(), undefined)
    assert.equal(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')).inboxDone[NAME], `peer:${NOW + 1}`)
    const ownReceipt = JSON.stringify({ version: 1, name: NAME, stamp: done[NAME] })
    assert.equal(readFileSync(livePage.pageDonePath(f.path, sha256(ownReceipt)), 'utf8'), ownReceipt)
    assert.equal(readFileSync(livePage.pageDonePath(f.path, sha256(peerReceipt)), 'utf8'), peerReceipt)
    assert.equal(writes, 1)
  } finally { await f.close() }
})

test('a concurrent successor may publish its own store size and cleared counts without a warning', async () => {
  const f = await fixture()
  const pruned = { [TODAY]: { agent: 5, mirror: 7 } }
  let writes = 0
  try {
    const production = publisher()
    const engine = publishingEngine(f, { afterWrite: async (file, text) => {
      if (file !== pageStatePath(f.path)) return
      writes += 1
      writeFileSync(file, JSON.stringify({ ...JSON.parse(text), store: 8192, pruned }))
    } })
    await production.syncPageState(engine, {})
    assert.equal(production.warning(), undefined)
    assert.deepEqual(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')), { version: 1, inboxDone: {}, store: 8192, pruned })
    assert.equal(writes, 1)
  } finally { await f.close() }
})

test('a fresh page and JSON reader keep valid receipts beside a partial receipt and retry its validation', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') })
  const otherName = `codex-turn-${NOW}-2.json`
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

test('a directory at a page receipt path is never counted as a verified acknowledgement', async () => {
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') })
  const text = JSON.stringify({ version: 1, name: NAME, stamp: `synthetic:${NOW}` })
  const final = livePage.pageDonePath(f.path, sha256(text))
  try {
    mkdirSync(final)
    const production = publisher()
    await production.syncPageState(publishingEngine(f), { [NAME]: `synthetic:${NOW}` })
    assert.match(production.warning(), /PAGE_STATE_NOT_VERIFIED/)
    assert.equal(production.isVerified(final), false)
    assert.equal(statSync(final).isDirectory(), true)
    assert.equal(readdirSync(final).length, 1, 'the move succeeded into the directory')
    assert.equal(existsSync(pageStatePath(f.path)), false)
    assert.equal((await f.api()).counts.waiting, 1)
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

test('a silently dropped page-state snapshot keeps its warning until an unchanged poll publishes it', async () => {
  const initial = { version: 1, inboxDone: {}, store: 4096, pruned: { [TODAY]: { agent: 2, mirror: 3 } } }
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') }, initial)
  let isDropped = true
  let writes = 0
  try {
    const production = publisher()
    const engine = publishingEngine(f, {
      beforeWrite: async file => { if (file === pageStatePath(f.path)) writes += 1 },
      isDropped: file => isDropped && file === pageStatePath(f.path),
    })
    const pending = await production.pendingTurns(engine)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].isQuestion, true)
    assert.equal(pending[0].text, 'Publish the synthetic build?')
    assert.deepEqual(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')), initial)
    assert.match(production.warning(), /PAGE_STATE_NOT_VERIFIED/)
    const attempts = writes
    assert.ok(attempts > 0)
    isDropped = false
    assert.equal((await production.pendingTurns(engine)).length, 1)
    assert.ok(writes > attempts, 'an unchanged poll must retry the snapshot')
    assert.deepEqual(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')), {
      version: 1, inboxDone: {}, store: 0, pruned: addPruned({}, { agent: 0, mirror: 0 }, NOW),
    })
    assert.equal(production.warning(), undefined)
  } finally { await f.close() }
})

test('a page-state snapshot torn after its write keeps its warning until a later poll publishes a valid one', async () => {
  const initial = { version: 1, inboxDone: {}, store: 4096, pruned: { [TODAY]: { agent: 2, mirror: 3 } } }
  const f = await fixture('', { [NAME]: turn('Publish the synthetic build?') }, initial)
  let isTorn = true
  try {
    const production = publisher()
    const engine = publishingEngine(f, {
      afterWrite: async file => { if (isTorn && file === pageStatePath(f.path)) writeFileSync(file, '{') },
    })
    assert.equal((await production.pendingTurns(engine)).length, 1)
    assert.equal(readFileSync(pageStatePath(f.path), 'utf8'), '{')
    assert.match(production.warning(), /PAGE_STATE_NOT_VERIFIED/)
    isTorn = false
    assert.equal((await production.pendingTurns(engine)).length, 1)
    assert.deepEqual(JSON.parse(readFileSync(pageStatePath(f.path), 'utf8')), {
      version: 1, inboxDone: {}, store: 0, pruned: addPruned({}, { agent: 0, mirror: 0 }, NOW),
    })
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
  const f = await fixture('', {}, { version: 1, at: NOW, inboxDone: {}, store: 2 * 1024 * 1024, pruned: { [TODAY]: { agent: 2, mirror: 3 } } })
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

test('a question in a block updated 30 minutes ago is shown as 30 minutes old, not as new as the page', async () => {
  const f = await fixture(`## demo\n<!-- auto session=abcdef12 agent=codex state=working updated=${new Date(NOW - 30 * 60000).toISOString()} -->\n### Release task\n- [?] Ship the synthetic build or wait\n<!-- /auto session=abcdef12 -->\n`)
  try {
    const model = await f.api()
    assert.equal(model.asks.length, 1, JSON.stringify(model.asks))
    assert.match(model.asks[0].when, /30/, model.asks[0].when)
  } finally { await f.close() }
})

test('a hand-kept task with a due date shows it on its row in place of the unknown age', async () => {
  const f = await fixture('## demo\n### Pay the synthetic invoice\n> 截止 11-06\n- [ ] Open the invoice\n')
  try {
    const model = await f.api()
    const row = model.groups.flatMap(group => group.rows).find(one => one.title === 'Pay the synthetic invoice')
    assert.ok(row?.due, JSON.stringify(model.groups))
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    const text = dom.node('board').readText
    assert.ok(text.includes(row.due), text)
    assert.ok(!text.includes(EN.pgUnknownAge), text)
  } finally { await f.close() }
})

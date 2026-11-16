// The page's open board request (#359): the board's server from source, the page played by its board
// requests (its etag and x-board-wait), and synthetic boards in a temporary folder. No model, no browser.
// The shipped page's half (it asks again at once while it holds the board) is checked in board.test.mjs,
// where the page script runs; the hook-to-page latency over every host is the L1 journey in
// tests/e2e/l1-first-run.test.mjs.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_EVENT_MS, PAGE_FALLBACK_MS } from './e2e/lib/budget.mjs'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })
const { startServer } = await import('../scripts/board-serve.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { EN } = await import('../hooks/strings-en.ts')

const pause = ms => new Promise(done => setTimeout(done, ms))
const roots = []
const boards = []
after(async () => {
  for (const board of boards) await board.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const blockOf = title => `## Synthetic watch\n<!-- auto session=abcd1234 agent=codex state=working updated=2026-11-16T12:00:00Z -->\n### ${title}\n- [~] Check the synthetic routes\n<!-- /auto session=abcd1234 -->\n`

// A board started from source. `fs` stands in for fs.watch; `holdMs` for how long an open request waits.
// `reads` counts how often the server built the board, which is where its file work is.
const startBoard = async ({ fs, holdMs, idleMs = 0, name = 'progress.md' } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'serve-watch-'))
  roots.push(root)
  const claude = join(root, '.claude')
  mkdirSync(claude)
  const progress = join(claude, name)
  const inbox = join(claude, 'progress-inbox')
  writeFileSync(progress, blockOf('First synthetic task'))
  const messages = join(root, 'messages')
  mkdirSync(messages)
  let reads = 0
  let stopped
  const isStopped = new Promise(done => { stopped = done })
  const address = await new Promise((resolve, reject) => {
    startServer({
      port: 0, messagesDirectory: messages, routes: [], s: EN, ping: {},
      view: () => { reads += 1; return buildView(parseProgress(readFileSync(progress, 'utf8')), [], null, Date.now(), 0, {}, EN) },
      pending: () => [], act: () => '', tidy: () => '', clean: () => '', sweep: () => {}, sweepMs: 60_000,
      paste: () => ({ isAdded: false, note: '' }), failure: () => null, idleMs,
      watch: { progress, inbox, ...(fs === undefined ? {} : { fs }) },
      ...(holdMs === undefined ? {} : { boardTimes: { holdMs } }),
      onReady: url => { resolve(url); return true },
      onStop: () => { stopped(); reject(new Error('stopped before ready')) },
    })
  })
  const url = new URL(address)
  const origin = `http://127.0.0.1:${url.port}`
  const token = url.searchParams.get('t')
  // The page's board request: with the etag of the board it holds, it waits for a change.
  const ask = async (etag, { headers = {}, page = 'p-watch' } = {}) => {
    const response = await fetch(new URL('/api/board', origin), { headers: { 'x-board-token': token, 'x-board-page': page, 'x-board-visible': '1', ...(etag === undefined ? {} : { 'if-none-match': etag, 'x-board-wait': '1' }), ...headers } })
    const text = await response.text()
    return { status: response.status, etag: response.headers.get('etag'), text, at: performance.now() }
  }
  const ping = () => fetch(new URL('/api/ping', origin), { headers: { 'x-board-token': token } }).then(response => response.json())
  const post = (path, body) => fetch(new URL(path, origin), { method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, text: await response.text() }))
  let isClosed = false
  const board = {
    root, claude, progress, inbox, ask, post, ping, isStopped, get reads() { return reads },
    // A board written the way the board itself and the hooks write it: a new file renamed over the old one.
    replace: title => {
      const temporary = `${progress}.${process.pid}.tmp`
      writeFileSync(temporary, blockOf(title))
      renameSync(temporary, progress)
    },
    close: async () => {
      if (isClosed) return
      isClosed = true
      await fetch(new URL('/api/close', origin), { method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined)
      await isStopped
    },
  }
  boards.push(board)
  return board
}

// Whether a request is still open after the server had time to answer it: the answer, or undefined.
const settledWithin = (promise, ms) => Promise.race([promise, pause(ms).then(() => undefined)])

test('serve: the page redraws from one open request, not a 3 s poll', async () => {
  const board = await startBoard({ holdMs: 60_000 })
  const first = await board.ask()
  assert.equal(first.status, 200)
  assert.match(first.text, /First synthetic task/)
  assert.ok(first.etag, 'the board comes with its etag')

  // Nothing changes: the request stays open, and once it has looked at the board on arrival the server
  // reads no file while it waits.
  const waiting = board.ask(first.etag)
  await pause(200)
  const readsBefore = board.reads
  assert.equal(await settledWithin(waiting, 3500), undefined, 'an unchanged board must not be answered on a timer')
  assert.equal(board.reads, readsBefore, 'the server built the board while nothing changed')

  // A write in place answers it with the new board.
  const writtenAt = performance.now()
  writeFileSync(board.progress, blockOf('Second synthetic task'))
  const second = await waiting
  assert.equal(second.status, 200)
  assert.match(second.text, /Second synthetic task/)
  assert.ok(second.at - writtenAt <= PAGE_EVENT_MS, `the change took ${Math.round(second.at - writtenAt)} ms to answer the open request`)
  assert.notEqual(second.etag, first.etag)

  // So does a new file renamed over progress.md, which a watch on the file itself would miss.
  const renamed = board.ask(second.etag)
  await pause(100)
  const renamedAt = performance.now()
  board.replace('Third synthetic task')
  const third = await renamed
  assert.equal(third.status, 200)
  assert.match(third.text, /Third synthetic task/)
  assert.ok(third.at - renamedAt <= PAGE_EVENT_MS, `the renamed file took ${Math.round(third.at - renamedAt)} ms to answer the open request`)

  // The inbox folder does not exist at the start: the first hook file makes it, and the server looks again.
  const quiet = board.ask(third.etag)
  await pause(100)
  const readsAtInbox = board.reads
  mkdirSync(board.inbox)
  writeFileSync(join(board.inbox, 'codex-turn-1.json'), '{}')
  for (let tries = 0; tries < 40 && board.reads === readsAtInbox; tries += 1) await pause(50)
  assert.ok(board.reads > readsAtInbox, 'a new inbox file did not wake the open request')
  // The board itself is unchanged by that file (this board's inbox stand-in shows nothing), so the request still waits.
  assert.equal(await settledWithin(quiet, 300), undefined, 'an unchanged board was answered after an inbox wake')
  const readsAtSecondFile = board.reads
  writeFileSync(join(board.inbox, 'codex-turn-2.json'), '{}')
  for (let tries = 0; tries < 40 && board.reads === readsAtSecondFile; tries += 1) await pause(50)
  assert.ok(board.reads > readsAtSecondFile, 'the inbox folder made after the start is not watched')
  // After all those real changes the watch is still trusted: nothing is built while nothing changes, longer than the
  // probe's interval and the timer's (a watch judged deaf would build every 2 s).
  await pause(300)
  const readsQuiet = board.reads
  await pause(3000)
  assert.equal(board.reads, readsQuiet, 'the watch was judged deaf after real changes, and the timer took over')
  await board.close()
  await quiet.catch(() => undefined)
})

test('serve: an open board request with no change is answered "no change" after its wait, and a request without an etag at once', async () => {
  const board = await startBoard({ holdMs: 300 })
  const first = await board.ask()
  const plain = await board.ask()
  assert.equal(plain.status, 200, 'a request that holds no board is answered at once')
  const held = await board.ask(first.etag)
  assert.equal(held.status, 304)
  assert.equal(held.etag, first.etag)
  await board.close()
})

test('serve: a press wakes the open board request, and a connector poll that hands out nothing does not', async () => {
  const board = await startBoard({ holdMs: 60_000 })
  const first = await board.ask()
  const waiting = board.ask(first.etag)
  await pause(200)
  // A connector polls every 2 s; one that gets no message leaves the board as it was, so it builds nothing.
  const atPoll = board.reads
  const polled = await board.post('/api/messages/poll', { connection: 'synthetic-connection', secret: 'synthetic-secret', turn: 'synthetic-turn' })
  assert.notEqual(polled.status, 200, 'the synthetic connection is unknown')
  await pause(300)
  assert.equal(board.reads, atPoll, 'a connector poll with no message woke the open request')
  // A press may change the board: the open request looks again (and, the board being the same, keeps waiting).
  const atPress = board.reads
  await board.post('/api/tidy', {})
  for (let tries = 0; tries < 40 && board.reads === atPress; tries += 1) await pause(50)
  assert.ok(board.reads > atPress, 'a press did not wake the open request')
  assert.equal(await settledWithin(waiting, 200), undefined, 'an unchanged board was answered after a press')
  await board.close()
  await waiting.catch(() => undefined)
})

test('serve: a board request without the token is refused at once, never held', async () => {
  const board = await startBoard({ holdMs: 60_000 })
  const first = await board.ask()
  // The page's waiting request with a wrong token, and with none: the same check as every request answers it.
  for (const token of ['synthetic-wrong-token', '']) {
    const answer = await settledWithin(board.ask(first.etag, { headers: { 'x-board-token': token } }), 2000)
    assert.ok(answer !== undefined, `a request with ${token ? 'a wrong' : 'no'} token was held`)
    assert.ok(answer.status === 401 || answer.status === 403, `a request with ${token ? 'a wrong' : 'no'} token got ${answer.status}`)
    assert.doesNotMatch(answer.text, /First synthetic task/)
  }
  await board.close()
})

test('serve: a tab left open does not keep an idle server alive', async () => {
  // The idle exit after 1.5 s; the page's waiting requests run out every 300 ms and it asks again at once.
  const keepAsking = async (board, visible, ms) => {
    let etag = (await board.ask()).etag
    const began = performance.now()
    while (performance.now() - began < ms) {
      try {
        const answer = await board.ask(etag, { headers: { 'x-board-visible': visible } })
        if (answer.status === 200) etag = answer.etag
      } catch { return }
      if (await settledWithin(board.isStopped.then(() => true), 0)) return
    }
  }
  // A tab in sight keeps it up while it waits, so the server does not go while someone reads the board, even when
  // one wait lasts longer than the idle time.
  const watched = await startBoard({ holdMs: 4000, idleMs: 1500 })
  await keepAsking(watched, '1', 5000)
  assert.equal(await settledWithin(watched.isStopped.then(() => true), 0), undefined, 'the server went while a tab in sight was waiting')
  await watched.close()
  // A hidden tab does not: the server goes after its idle time.
  const hidden = await startBoard({ holdMs: 300, idleMs: 1500 })
  await keepAsking(hidden, '0', 15_000)
  assert.ok(await settledWithin(hidden.isStopped.then(() => true), 1000), 'the server stayed up while only a hidden tab was waiting')
})

test('serve: with a progress file of another name, the inbox folder made later is still watched', async () => {
  const board = await startBoard({ holdMs: 60_000, name: 'tasks.md' })
  const first = await board.ask()
  const waiting = board.ask(first.etag)
  await pause(200)
  const before = board.reads
  mkdirSync(board.inbox)
  writeFileSync(join(board.inbox, 'codex-turn-1.json'), '{}')
  for (let tries = 0; tries < 40 && board.reads === before; tries += 1) await pause(50)
  const afterFolder = board.reads
  assert.ok(afterFolder > before, 'the new inbox folder did not wake the open request')
  writeFileSync(join(board.inbox, 'codex-turn-2.json'), '{}')
  for (let tries = 0; tries < 40 && board.reads === afterFolder; tries += 1) await pause(50)
  assert.ok(board.reads > afterFolder, 'a file in the inbox folder made after the start did not wake the open request')
  await board.close()
  await waiting.catch(() => undefined)
})

test('serve: a page waiting on the board counts as open just now, and one replaced while it waits is told at once', async () => {
  const board = await startBoard({ holdMs: 60_000 })
  const first = await board.ask()
  const waiting = board.ask(first.etag)
  // Longer than a page's last request alone would keep it "just now": the board command's open-window check reads this.
  await pause(1500)
  const { pageAgo } = await board.ping()
  assert.ok(pageAgo !== null && pageAgo < 500, `a page in sight waiting on the board was last seen ${pageAgo} ms ago`)
  // A newer page asks: the older one's waiting request is answered that the board moved (#265), not after its wait.
  await board.ask(undefined, { page: 'p-newer' })
  const moved = await settledWithin(waiting, 2000)
  assert.ok(moved !== undefined, 'the replaced page was still waiting')
  assert.deepEqual(JSON.parse(moved.text), { moved: true })
  await board.close()
})

// A watch that never reports a change, as one that stopped would, and can be made to fail.
const deafWatch = () => {
  const made = []
  const fs = () => {
    const one = new EventEmitter()
    one.close = () => {}
    made.push(one)
    return one
  }
  return { fs, made }
}

test('serve: when the file watch fails, the page still updates within 3 s from a timer check', async () => {
  // The watch cannot be set up at all.
  {
    const board = await startBoard({ holdMs: 60_000, fs: () => { throw Object.assign(new Error('synthetic: no watches left'), { code: 'ENOSPC' }) } })
    const first = await board.ask()
    const waiting = board.ask(first.etag)
    await pause(200)
    const writtenAt = performance.now()
    writeFileSync(board.progress, blockOf('Seen without a watch'))
    const answer = await waiting
    assert.equal(answer.status, 200)
    assert.match(answer.text, /Seen without a watch/)
    assert.ok(answer.at - writtenAt <= PAGE_FALLBACK_MS, `without a watch the change took ${Math.round(answer.at - writtenAt)} ms`)
    await board.close()
  }
  // The watch was set up and then stopped with an error (its folder went away on Windows, say).
  {
    const watch = deafWatch()
    const board = await startBoard({ holdMs: 60_000, fs: watch.fs })
    assert.ok(watch.made.length >= 1, 'the server set up a watch')
    const first = await board.ask()
    const waiting = board.ask(first.etag)
    await pause(200)
    watch.made[0].emit('error', Object.assign(new Error('synthetic: watch stopped'), { code: 'EPERM' }))
    const failedAt = performance.now()
    writeFileSync(board.progress, blockOf('Missed by the stopped watch'))
    const answer = await waiting
    assert.equal(answer.status, 200)
    assert.match(answer.text, /Missed by the stopped watch/)
    assert.ok(answer.at - failedAt <= PAGE_FALLBACK_MS, `after the watch stopped the change took ${Math.round(answer.at - failedAt)} ms`)
    await board.close()
  }
  // The watch set up fine and never reports anything, and never fails (WSL's /mnt/c, some network mounts).
  {
    const watch = deafWatch()
    const board = await startBoard({ holdMs: 60_000, fs: watch.fs })
    const first = await board.ask()
    const waiting = board.ask(first.etag)
    await pause(200)
    const writtenAt = performance.now()
    writeFileSync(board.progress, blockOf('Missed by the deaf watch'))
    const answer = await waiting
    assert.equal(answer.status, 200)
    assert.match(answer.text, /Missed by the deaf watch/)
    assert.ok(answer.at - writtenAt <= PAGE_FALLBACK_MS, `with a deaf watch the change took ${Math.round(answer.at - writtenAt)} ms`)
    // Later changes come from the timer check.
    const next = board.ask(answer.etag)
    await pause(200)
    const laterAt = performance.now()
    writeFileSync(board.progress, blockOf('Seen from the timer'))
    const later = await next
    assert.match(later.text, /Seen from the timer/)
    assert.ok(later.at - laterAt <= PAGE_FALLBACK_MS, `from the timer the change took ${Math.round(later.at - laterAt)} ms`)
    await board.close()
  }
})

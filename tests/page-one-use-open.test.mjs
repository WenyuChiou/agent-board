import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  },
})

const { parseProgress } = await import('../hooks/parse.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { buildView } = await import('../hooks/view.ts')
const { startServer } = await import('../scripts/board-serve.ts')
const { addressFileName, addressKey } = await import('../hooks/receiver.ts')

const OPEN_LINK_RE = /http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+/
const REUSABLE_LINK_RE = /\?t=/
const delay = ms => new Promise(done => setTimeout(done, ms))

const startDirectBoard = async ({ now, openLinkMs, open, openRedeemMs = 200, openLinkMax } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'board-one-use-srv-'))
  const progress = join(root, 'progress.md')
  const messages = join(root, 'messages')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(messages, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')
  const addressFile = join(runtimeDir, addressFileName(addressKey(progress)))
  const opened = []
  let stopped
  const isStopped = new Promise(done => { stopped = done })
  const address = await new Promise((resolve, reject) => {
    startServer({
      port: 0,
      messagesDirectory: messages,
      routes: [],
      s: EN,
      ping: { ok: true },
      addressFile,
      view: () => buildView(parseProgress(readFileSync(progress, 'utf8')), [], null, Date.now(), 0, {}, EN),
      pending: () => [],
      act: () => '',
      tidy: () => '',
      clean: () => '',
      sweep: () => {},
      sweepMs: 60_000,
      paste: () => ({ isAdded: false, note: '' }),
      failure: () => null,
      idleMs: 0,
      openRedeemMs,
      ...(now === undefined ? {} : { now }),
      ...(openLinkMs === undefined ? {} : { openLinkMs }),
      ...(openLinkMax === undefined ? {} : { openLinkMax }),
      watch: { progress, inbox: join(root, 'inbox'), fs: () => Object.assign(new EventEmitter(), { close: () => {} }) },
      open: async url => { opened.push(url); return open ? open(url) : true },
      onReady: url => { resolve(url); return true },
      onListenError: reject,
      onStop: () => stopped(),
    })
  })
  writeFileSync(addressFile, JSON.stringify({ pid: process.pid, port: Number(new URL(address).port), url: address, path: progress, built: '' }))
  const parsed = new URL(address)
  const token = parsed.searchParams.get('t')
  const origin = parsed.origin
  const call = async (path, body, headers = {}) => {
    const res = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = {}
    try { data = text === '' ? {} : JSON.parse(text) } catch {}
    return { status: res.status, text, body: data, headers: res.headers }
  }
  const close = async () => {
    await call('/api/close', {}).catch(() => undefined)
    await isStopped
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  return { root, origin, token, addressFile, opened, call, close }
}

const sessionFromHtml = html => {
  const match = /<script type="application\/json" id="page-session">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, 'HTML embeds #page-session JSON')
  const value = JSON.parse(match[1])
  assert.equal(typeof value, 'string')
  assert.ok(value.length >= 16)
  return value
}

test('concurrent and non-GET requests against a one-use link consume it at most once', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    assert.equal((await board.call('/api/open-link', {}, { origin: board.origin })).status, 403)
    const minted = await board.call('/api/open-link', {})
    assert.equal(minted.status, 200)
    assert.match(minted.body.url, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+$/)
    const oneUseUrl = minted.body.url

    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      assert.equal((await fetch(oneUseUrl, { method })).status, 405, `${method} must be refused without consuming link`)
    }
    assert.equal((await fetch(oneUseUrl, { headers: { 'sec-purpose': 'prefetch' } })).status, 403)

    // Invalid Host header gets 421 and must not consume the code (use node:http to send custom Host header).
    const target = new URL(oneUseUrl)
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: target.port, method: 'GET', path: target.pathname, headers: { host: `evil.example:${target.port}` } }, res => {
        res.resume().on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(badHostStatus, 421)

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => fetch(oneUseUrl)))
    assert.deepEqual(concurrent.map(res => res.status).sort((x, y) => x - y), [200, 403, 403, 403, 403, 403, 403, 403])
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('an expired one-use link is refused, and a full open-link table refuses a new mint instead of pushing a code out', { timeout: 20_000 }, async () => {
  let clock = 1_000_000
  const board = await startDirectBoard({ now: () => clock, openLinkMs: 5_000 })
  let failed = false
  try {
    const first = await board.call('/api/open-link', {})
    assert.equal(first.status, 200)
    clock += 6_000
    assert.equal((await fetch(first.body.url)).status, 403)

    const links = []
    for (let i = 0; i < 64; i += 1) {
      const minted = await board.call('/api/open-link', {})
      assert.equal(minted.status, 200)
      links.push(minted.body.url)
    }
    const extra = await board.call('/api/open-link', {})
    assert.equal(extra.status, 503, 'the 65th unused link is refused')
    assert.deepEqual(extra.body, { error: 'busy' })
    assert.equal((await fetch(links[0])).status, 200, 'the oldest unused link was not pushed out')
    assert.equal((await fetch(links[0])).status, 403)
    // A link used frees its place.
    assert.equal((await board.call('/api/open-link', {})).status, 200)
    // Past their lifetime the rest go, and minting works again.
    clock += 6_000
    assert.equal((await fetch(links[63])).status, 403)
    assert.equal((await board.call('/api/open-link', {})).status, 200)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a link the command minted first still works when windows that never loaded fill the cap', { timeout: 20_000 }, async () => {
  // A cap of four stands for the board's 64: three keyed codes from windows that never loaded stay,
  // then a command mints its link, and its own window's code finds the table full.
  const board = await startDirectBoard({ openLinkMax: 4, openRedeemMs: 0 })
  let failed = false
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await board.call('/api/open', { asApp: true })).body.isRedeemed, false)
    const fallback = (await board.call('/api/open-link', {})).body.url
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 503, 'the table is full: the window is not opened')
    assert.deepEqual(opened.body, { error: 'busy' })
    assert.equal(board.opened.length, 3, 'the refused open started no window')
    // The command prints the link it minted first: it still lets the person in.
    const res = await fetch(fallback)
    assert.equal(res.status, 200, 'the printed link was pushed out by the window code minted after it')
    assert.equal((await res.text()).includes('id="page-session"'), true)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('page session cannot call client-only control routes, and /api/open uses a one-use link that pairs the page secret for /api/approvals/switch', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 200)
    assert.equal(board.opened.length, 1)
    assert.match(board.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+#k=[\w-]+$/)
    assert.doesNotMatch(board.opened[0], REUSABLE_LINK_RE)

    const [openUrl, fragment] = board.opened[0].split('#')
    const pairKey = /^k=([\w-]+)$/.exec(fragment)?.[1]
    assert.ok(pairKey)

    const redeemed = await fetch(openUrl)
    assert.equal(redeemed.status, 200)
    const html = await redeemed.text()
    const pageSession = sessionFromHtml(html)
    assert.notEqual(pageSession, board.token)

    const asPage = (path, body, extra = {}, sendOrigin = true) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': pageSession,
        'x-board-page': 'p-one-use',
        ...(sendOrigin ? { origin: board.origin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    for (const withOrigin of [false, true]) {
      assert.equal((await asPage('/api/board', undefined, {}, withOrigin)).status, 200)
      assert.equal((await asPage('/api/ping', undefined, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/open', { asApp: true }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/open-link', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/lan', { address: '' }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/package', { version: '9.9.9' }, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/approvals/ask', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/messages/poll', {}, {}, withOrigin)).status, 403)
      assert.equal((await asPage('/api/messages/register', {}, {}, withOrigin)).status, 403)
    }

    // When /api/open's opener fails, the freshly minted unused open code is deleted immediately.
    const failingOpenBoard = await startDirectBoard({ open: async () => false })
    try {
      const failedOpened = await failingOpenBoard.call('/api/open', { asApp: true })
      assert.equal(failedOpened.status, 200)
      assert.equal(failingOpenBoard.opened.length, 1)
      const [failedOpenUrl] = failingOpenBoard.opened[0].split('#')
      assert.match(failedOpenUrl, OPEN_LINK_RE)
      assert.equal((await fetch(failedOpenUrl)).status, 403, 'failed /api/open deletes unused code immediately')
    } finally {
      await failingOpenBoard.close()
    }

    const paired = await asPage('/api/approvals/pair', { key: pairKey })
    assert.equal(paired.status, 200)
    const secret = (await paired.json()).secret
    assert.equal(typeof secret, 'string')
    assert.ok(secret.length > 0)

    const switchClientOnly = await board.call('/api/approvals/switch', { enabled: false }, { origin: board.origin, 'x-board-page': 'p-one-use' })
    assert.equal(switchClientOnly.status, 403)
    const switchWithoutSecret = await asPage('/api/approvals/switch', { enabled: false })
    assert.equal(switchWithoutSecret.status, 403)

    const switched = await asPage('/api/approvals/switch', { enabled: false }, { 'x-board-approve': secret })
    assert.equal(switched.status, 200)
    assert.equal((await switched.json()).isOff, true)
    assert.equal((await fetch(openUrl)).status, 403, 'replaying the keyed /open/ link is refused')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('replaying a keyed one-use open link after attacker pairs #k revokes the attacker secret and locks approvals off', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 200)
    const [openUrl, fragment] = board.opened[0].split('#')
    const pairKey = /^k=([\w-]+)$/.exec(fragment)?.[1]
    assert.ok(pairKey)

    const attackerGet = await fetch(openUrl)
    assert.equal(attackerGet.status, 200)
    const attackerSession = sessionFromHtml(await attackerGet.text())

    const asAttacker = (path, body, extra = {}) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': attackerSession,
        'x-board-page': 'p-attacker',
        origin: board.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const paired = await asAttacker('/api/approvals/pair', { key: pairKey })
    assert.equal(paired.status, 200)
    const { secret } = await paired.json()
    assert.ok(typeof secret === 'string' && secret.length > 0)

    // Real browser opens the stolen link second: 403 and approvals lock down immediately.
    const browserGet = await fetch(openUrl)
    assert.equal(browserGet.status, 403)

    const boardState = await (await asAttacker('/api/board')).json()
    assert.equal(boardState.approvals?.isLockdown, true, 'replay locks approvals off')
    const switchAfterReplay = await asAttacker('/api/approvals/switch', { enabled: false }, { 'x-board-approve': secret })
    assert.equal(switchAfterReplay.status, 403, 'attacker secret is revoked after open-link replay')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

// Runs the page's own script against a fake document. Timers wait until the test runs them, so the
// test drives the page's poll; listeners are kept so the test can press a button.
const runServedPageInOrigin = async (html, pageUrl, originStores, { throwStorage = false } = {}) => {
  const nodes = new Map()
  const makeEl = tag => ({
    tag,
    childNodes: [],
    attributes: {},
    style: {},
    listeners: {},
    className: '',
    value: '',
    _text: '',
    set textContent(v) { this._text = v; if (v === '') this.childNodes = [] },
    get textContent() { return this._text },
    // The page script reads a shelf head's first child, its chevron (#1937).
    get firstChild() { return this.childNodes[0] ?? null },
    set id(v) { this.attributes.id = v; nodes.set(v, this) },
    get id() { return this.attributes.id ?? '' },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c },
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c) },
    insertBefore(c) { return this.appendChild(c) },
    insertAdjacentElement() {},
    remove() { this.parentNode?.removeChild(this) },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') nodes.set(v, this) },
    getAttribute(k) { return this.attributes[k] ?? null },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    querySelectorAll() { return [] },
    querySelector() { return makeEl('div') },
  })
  const mainEl = makeEl('main')
  const textOf = el => el.textContent + el.childNodes.map(textOf).join('')
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeEl('div'))
    return nodes.get(id)
  }
  const words = html.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)
  if (words) get('words').textContent = words[1]
  const pageSessionTag = html.match(/<script[^>]*id="page-session"[^>]*>([\s\S]*?)<\/script>/)
  if (pageSessionTag) get('page-session').textContent = pageSessionTag[1]
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .find(code => code.includes('(function ()'))
  assert.ok(script, 'served HTML contains PAGE_SCRIPT')

  const url = new URL(pageUrl)
  if (!originStores.has(url.origin)) originStores.set(url.origin, new Map())
  const store = originStores.get(url.origin)
  const sessionStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  }
  let currentPath = url.pathname + url.search + url.hash
  // Window events the page listens for (pageshow, pagehide); the test fires them, as the browser would.
  const windowListeners = {}
  let boardPollResolve
  const fetched = []
  const firstBoardPoll = new Promise(resolve => { boardPollResolve = resolve })
  const timers = new Map()
  let timerSeq = 0
  const document = {
    body: get('body'),
    getElementById: id => nodes.get(id) ?? get(id),
    createElement: makeEl,
    createTextNode: () => makeEl('text'),
    querySelector: selector => selector === 'main' ? mainEl : makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    title: '',
  }
  const vmContext = {
    document,
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: { replaceState: (_s, _t, next) => { currentPath = next } },
    URLSearchParams,
    crypto: { randomUUID },
    window: { addEventListener: (type, fn) => { (windowListeners[type] ??= []).push(fn) } },
    navigator: {},
    setTimeout: fn => { timerSeq += 1; timers.set(timerSeq, fn); return timerSeq },
    clearTimeout: id => { timers.delete(id) },
    fetch: async (target, init = {}) => {
      fetched.push(String(target))
      const res = await fetch(new URL(target, url.origin), {
        ...init,
        headers: { ...(init.headers ?? {}), origin: url.origin },
      })
      if (String(target).startsWith('/api/board')) boardPollResolve({ status: res.status, tokenSent: init.headers?.['x-board-token'] ?? '' })
      return res
    },
  }
  if (throwStorage) {
    Object.defineProperty(vmContext, 'sessionStorage', {
      enumerable: true,
      configurable: true,
      get() { throw new Error('SecurityError') },
    })
  } else {
    vmContext.sessionStorage = sessionStorage
  }
  runInNewContext(script, vmContext, { timeout: 1000 })
  return {
    firstBoardPoll,
    polled: () => fetched.some(path => path.startsWith('/api/board')),
    pollCount: () => fetched.filter(path => path.startsWith('/api/board')).length,
    fetched: () => [...fetched],
    // Runs every timer that is due by now, as the browser would once their delays pass.
    runTimers: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) { try { fn() } catch {} }
      return due.length
    },
    fireWindow: (type, event) => { for (const fn of windowListeners[type] ?? []) fn(event) },
    press: id => { for (const fn of get(id).listeners.click ?? []) fn({ preventDefault() {} }) },
    currentPath: () => currentPath,
    offlineText: () => textOf(get('offline')),
    mainText: () => textOf(mainEl),
  }
}

const waitUntil = async (isDone, what, waitMs = 3_000) => {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && !isDone()) await delay(20)
  assert.ok(isDone(), what)
}

test('two local boards on different ports issue no cookies, reload independently via origin-scoped sessionStorage, and reject each other sessions', { timeout: 25_000 }, async () => {
  const boardA = await startDirectBoard()
  const boardB = await startDirectBoard()
  let failed = false
  try {
    const linkA = (await boardA.call('/api/open-link', {})).body.url
    const linkB = (await boardB.call('/api/open-link', {})).body.url
    const resA = await fetch(linkA)
    const resB = await fetch(linkB)
    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)
    assert.equal(resA.headers.get('set-cookie'), null)
    assert.equal(resB.headers.get('set-cookie'), null)
    const htmlA = await resA.text()
    const htmlB = await resB.text()
    const sessionA = sessionFromHtml(htmlA)
    const sessionB = sessionFromHtml(htmlB)
    assert.notEqual(sessionA, sessionB)

    const originStores = new Map()
    const pageA1 = await runServedPageInOrigin(htmlA, linkA, originStores)
    assert.equal(pageA1.currentPath(), '/')
    assert.deepEqual(await pageA1.firstBoardPoll, { status: 200, tokenSent: sessionA })

    const pageB1 = await runServedPageInOrigin(htmlB, linkB, originStores)
    assert.equal(pageB1.currentPath(), '/')
    assert.deepEqual(await pageB1.firstBoardPoll, { status: 200, tokenSent: sessionB })

    // Opening B leaves A's origin-scoped session intact; reloading bare GET / on A still loads A's board.
    const reloadA = await fetch(new URL('/', boardA.origin))
    assert.equal(reloadA.status, 200)
    assert.equal(reloadA.headers.get('set-cookie'), null)
    const pageA2 = await runServedPageInOrigin(await reloadA.text(), `${boardA.origin}/`, originStores)
    assert.deepEqual(await pageA2.firstBoardPoll, { status: 200, tokenSent: sessionA })

    const reloadB = await fetch(new URL('/', boardB.origin))
    assert.equal(reloadB.status, 200)
    const pageB2 = await runServedPageInOrigin(await reloadB.text(), `${boardB.origin}/`, originStores)
    assert.deepEqual(await pageB2.firstBoardPoll, { status: 200, tokenSent: sessionB })

    // Also verify bare GET / does not bump pageAgo when no authenticated page asked yet.
    const boardC = await startDirectBoard()
    try {
      const beforeBare = await boardC.call('/api/ping')
      assert.equal(beforeBare.body.pageAgo, null)
      assert.equal((await fetch(new URL('/', boardC.origin))).status, 200)
      const afterBare = await boardC.call('/api/ping')
      assert.equal(afterBare.body.pageAgo, null, 'bare GET / shell reload does not count as an open page')
    } finally {
      await boardC.close()
    }

    // Sessions stay isolated per board server.
    assert.equal((await fetch(new URL('/api/board', boardA.origin), { headers: { 'x-board-token': sessionB } })).status, 403)
    assert.equal((await fetch(new URL('/api/board', boardB.origin), { headers: { 'x-board-token': sessionA } })).status, 403)

    // Throwing sessionStorage getter (strict privacy / sandboxed iframes) must not abort page boot.
    const blockedLink = (await boardA.call('/api/open-link', {})).body.url
    const blockedRes = await fetch(blockedLink)
    assert.equal(blockedRes.status, 200)
    const blockedHtml = await blockedRes.text()
    const blockedSession = sessionFromHtml(blockedHtml)
    const blockedPage = await runServedPageInOrigin(blockedHtml, blockedLink, originStores, { throwStorage: true })
    assert.equal(blockedPage.currentPath(), '/')
    assert.deepEqual(await blockedPage.firstBoardPoll, { status: 200, tokenSent: blockedSession })
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await boardA.close() } catch (cleanupError) { if (!failed) throw cleanupError }
    try { await boardB.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

const assertSessionLostScreen = (page, store, label) => {
  assert.ok(page.mainText().includes(EN.serveSessionLost), `${label}: ${page.mainText()}`)
  assert.equal(page.offlineText(), '', `${label}: not the offline banner`)
  assert.equal(page.mainText().includes(EN.serveOffline), false, label)
  assert.equal(store.get('agent_board_session'), undefined, `${label}: the session leaves the tab's storage`)
}

test('a used or expired link shows how to get a new one', { timeout: 25_000 }, async () => {
  let clock = 1_000_000
  const board = await startDirectBoard({ now: () => clock, openLinkMs: 5_000 })
  let failed = false
  try {
    const used = (await board.call('/api/open-link', {})).body.url
    assert.equal((await (await fetch(used)).text()).includes('id="page-session"'), true)
    const expired = (await board.call('/api/open-link', {})).body.url
    clock += 6_000
    const unknown = `${board.origin}/open/${'x'.repeat(32)}`
    // A keyed link a stranger used first: the person's own window gets the same page, and approvals go off.
    const keyed = await board.call('/api/open', { asApp: true })
    assert.equal(keyed.status, 200)
    const [keyedUrl] = board.opened[0].split('#')
    assert.equal((await (await fetch(keyedUrl)).text()).includes('id="page-session"'), true)

    for (const [label, link] of [['a used link', used], ['an expired link', expired], ['an unknown link', unknown], ['a keyed link opened twice', keyedUrl]]) {
      const res = await fetch(link)
      assert.equal(res.status, 403, label)
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/, `${label}: a page, not a bare {}`)
      const html = await res.text()
      assert.equal(html.includes('id="page-session"'), false, `${label}: no session in it`)
      assert.equal(html.includes(board.token), false, label)
      const store = new Map()
      const page = await runServedPageInOrigin(html, link, new Map([[board.origin, store]]))
      await waitUntil(() => page.mainText().includes(EN.serveSessionLost), `${label}: ${page.mainText()}`)
      assertSessionLostScreen(page, store, label)
      assert.equal(page.polled(), false, `${label}: nothing to poll with`)
      assert.equal(page.currentPath(), '/', `${label}: the dead code leaves the address bar`)
    }
    // The same used link opened in a tab that still holds a live session (one from scrollback pasted
    // into the board's own tab): the same screen, and the tab's session ends with it.
    const live = (await board.call('/api/open-link', {})).body.url
    const tab = new Map()
    const first = await runServedPageInOrigin(await (await fetch(live)).text(), live, new Map([[board.origin, tab]]))
    assert.equal((await first.firstBoardPoll).status, 200, 'the tab is signed in first')
    assert.ok(tab.get('agent_board_session'), 'the tab keeps its session')
    const again = await runServedPageInOrigin(await (await fetch(used)).text(), used, new Map([[board.origin, tab]]))
    await waitUntil(() => again.mainText().includes(EN.serveSessionLost), `a used link in a signed-in tab: ${again.mainText()}`)
    assertSessionLostScreen(again, tab, 'a used link in a signed-in tab')
    assert.equal(again.polled(), false, 'a used link in a signed-in tab: no poll with the old session')
    const ping = await board.call('/api/board')
    assert.equal(ping.body.approvals?.isLockdown, true, 'the second use of a keyed link still turns approvals off')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('any rejected page call ends in the session-lost screen', { timeout: 30_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const openPage = async () => {
      const link = (await board.call('/api/open-link', {})).body.url
      const res = await fetch(link)
      const html = await res.text()
      const store = new Map()
      const page = await runServedPageInOrigin(html, link, new Map([[board.origin, store]]))
      assert.equal((await page.firstBoardPoll).status, 200)
      return { page, store }
    }
    const polling = await openPage()
    const pressing = await openPage()
    // The board forgets both pages' sessions on its own while it keeps running: 64 newer pages push them
    // out of the sessions it keeps.
    for (let index = 0; index < 64; index += 1) {
      const link = (await board.call('/api/open-link', {})).body.url
      await (await fetch(link)).text()
    }

    // A poll: the page's next scheduled refresh meets the rejection.
    const before = polling.page.pollCount()
    await waitUntil(() => { polling.page.runTimers(); return polling.page.pollCount() > before }, 'the page polls again when its timer runs')
    await waitUntil(() => polling.page.mainText().includes(EN.serveSessionLost), `the poll ends in the session-lost screen: ${polling.page.mainText()}`)
    assertSessionLostScreen(polling.page, polling.store, 'a poll')
    const polls = polling.page.pollCount()
    for (let round = 0; round < 5; round += 1) { polling.page.runTimers(); await delay(20) }
    assert.equal(polling.page.pollCount(), polls, 'polling stops for good')

    // A press: the page's own close button is the call that meets the rejection.
    const fetchedBefore = pressing.page.fetched().length
    const pollsBeforePress = pressing.page.pollCount()
    pressing.page.press('close')
    await waitUntil(() => pressing.page.fetched().slice(fetchedBefore).includes('/api/close'), 'the press reaches the board')
    await waitUntil(() => pressing.page.mainText().includes(EN.serveSessionLost), `the press ends in the session-lost screen: ${pressing.page.mainText()}`)
    assertSessionLostScreen(pressing.page, pressing.store, 'a press')
    // The press's own answer ends the page: no poll is needed to find out, so none follows it.
    assert.equal(pressing.page.pollCount(), pollsBeforePress, `the press alone decides: ${pressing.page.fetched().slice(fetchedBefore)}`)
    const pressPolls = pressing.page.pollCount()
    for (let round = 0; round < 5; round += 1) { pressing.page.runTimers(); await delay(20) }
    assert.equal(pressing.page.pollCount(), pressPolls, 'no poll after the press either')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a reload with storage blocked asks for a fresh link', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const link = (await board.call('/api/open-link', {})).body.url
    const html = await (await fetch(link)).text()
    const stores = new Map()
    const opened = await runServedPageInOrigin(html, link, stores, { throwStorage: true })
    assert.equal((await opened.firstBoardPoll).status, 200, 'the first load works without storage')

    const bare = await fetch(new URL('/', board.origin))
    assert.equal(bare.status, 200)
    const shell = await bare.text()
    assert.equal(shell.includes('id="page-session"'), false, 'the bare shell holds no session')
    const reload = await runServedPageInOrigin(shell, `${board.origin}/`, stores, { throwStorage: true })
    await waitUntil(() => reload.mainText().includes(EN.serveSessionLost), `the reload asks for a fresh link: ${reload.mainText()}`)
    assert.equal(reload.polled(), false, 'no poll with an empty credential')
    assert.equal(reload.offlineText(), '')
    assert.equal(reload.mainText().includes(EN.serveOffline), false)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a full table of unused codes keeps the one an open waits on and the command code, and refuses the extra mint', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard({ openLinkMax: 4, openRedeemMs: 5_000 })
  let failed = false
  try {
    const command = (await board.call('/api/open-link', {})).body.url
    const spare = (await board.call('/api/open-link', {})).body.url
    // A window opened and not yet loaded: the request waits for its code.
    const waiting = board.call('/api/open', { asApp: true, waitRedeem: true })
    await waitUntil(() => board.opened.length === 1, 'the open reached the opener')
    const last = (await board.call('/api/open-link', {})).body.url

    // The table is full of unused codes. Neither kind of mint pushes one out.
    const extraLink = await board.call('/api/open-link', {})
    assert.equal(extraLink.status, 503)
    assert.deepEqual(extraLink.body, { error: 'busy' })
    const extraWindow = await board.call('/api/open', { asApp: true })
    assert.equal(extraWindow.status, 503)
    assert.deepEqual(extraWindow.body, { error: 'busy' })
    assert.equal(board.opened.length, 1, 'the refused open started no window')

    // The window the request waits on loads its code within the wait; its answer says so.
    const [waitedUrl] = board.opened[0].split('#')
    assert.equal((await fetch(waitedUrl)).status, 200, 'the waited-on code still redeems')
    const answer = await waiting
    assert.equal(answer.status, 200)
    assert.equal(answer.body.isRedeemed, true)
    assert.equal((await fetch(command)).status, 200, 'the command code still redeems')
    assert.equal((await fetch(spare)).status, 200)
    assert.equal((await fetch(last)).status, 200)
    // Codes used leave room again.
    assert.equal((await board.call('/api/open-link', {})).status, 200)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a replay record of a keyed link survives a full table, so its replay still turns approvals off', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard({ openLinkMax: 3, openRedeemMs: 0 })
  let failed = false
  try {
    const opened = await board.call('/api/open', { asApp: true })
    assert.equal(opened.status, 200)
    const [openUrl, fragment] = board.opened[0].split('#')
    const pairKey = /^k=([\w-]+)$/.exec(fragment)?.[1]
    assert.ok(pairKey)
    // The table fills with unused codes, then the keyed link is used by someone who pairs with it.
    assert.equal((await board.call('/api/open-link', {})).status, 200)
    assert.equal((await board.call('/api/open-link', {})).status, 200)
    assert.equal((await board.call('/api/open-link', {})).status, 503, 'the table is full')
    const attackerGet = await fetch(openUrl)
    assert.equal(attackerGet.status, 200)
    const attackerSession = sessionFromHtml(await attackerGet.text())
    const asAttacker = (path, body, extra = {}) => fetch(new URL(path, board.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-board-token': attackerSession,
        'x-board-page': 'p-attacker',
        origin: board.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const paired = await asAttacker('/api/approvals/pair', { key: pairKey })
    assert.equal(paired.status, 200)
    const { secret } = await paired.json()
    assert.ok(typeof secret === 'string' && secret.length > 0)

    // More mints, and a full table again: the used keyed code is not the one that goes, and it takes no place.
    assert.equal((await board.call('/api/open-link', {})).status, 200)
    assert.equal((await board.call('/api/open-link', {})).status, 503, 'full again')
    assert.equal((await board.call('/api/open-link', {})).status, 503)

    // The real browser opens the same link second: refused, and the record turns approvals off.
    assert.equal((await fetch(openUrl)).status, 403)
    const state = await (await asAttacker('/api/board')).json()
    assert.equal(state.approvals?.isLockdown, true, 'the replay still locks approvals off')
    const switchAfter = await asAttacker('/api/approvals/switch', { enabled: false }, { 'x-board-approve': secret })
    assert.equal(switchAfter.status, 403, 'the attacker secret is revoked')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a live page, then a dead link in the same tab, then Back: the restored page shows the session-lost screen and does not poll', { timeout: 30_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const live = (await board.call('/api/open-link', {})).body.url
    const used = (await board.call('/api/open-link', {})).body.url
    assert.equal((await fetch(used)).status, 200)
    const tab = new Map()
    const stores = new Map([[board.origin, tab]])
    const first = await runServedPageInOrigin(await (await fetch(live)).text(), live, stores)
    assert.equal((await first.firstBoardPoll).status, 200)
    const session = tab.get('agent_board_session')
    assert.ok(session, 'the page keeps its session in the tab')

    // Back to a page the browser kept, while the tab's session is still there: it polls again, as before.
    const before = first.pollCount()
    first.fireWindow('pageshow', { persisted: true })
    await waitUntil(() => first.pollCount() > before, 'a restored page with its session polls again')
    assert.equal(first.mainText().includes(EN.serveSessionLost), false)

    // The tab follows a dead link: that page ends the session in the tab's storage.
    const dead = await runServedPageInOrigin(await (await fetch(used)).text(), used, stores)
    await waitUntil(() => dead.mainText().includes(EN.serveSessionLost), 'the dead link shows the session-lost screen')
    assert.equal(tab.get('agent_board_session'), undefined)

    // Back: the first page comes out of the browser's cache with its session still in memory.
    const polls = first.pollCount()
    first.fireWindow('pageshow', { persisted: true })
    await waitUntil(() => first.mainText().includes(EN.serveSessionLost), `the restored page ends on the session-lost screen: ${first.mainText()}`)
    for (let round = 0; round < 5; round += 1) { first.runTimers(); await delay(20) }
    assert.equal(first.pollCount(), polls, 'the restored page makes no further poll')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a restored page whose tab storage cannot be read ends on the session-lost screen and does not poll', { timeout: 30_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const live = (await board.call('/api/open-link', {})).body.url
    const tab = new Map()
    const stores = new Map([[board.origin, tab]])
    const first = await runServedPageInOrigin(await (await fetch(live)).text(), live, stores)
    assert.equal((await first.firstBoardPoll).status, 200)
    assert.ok(tab.get('agent_board_session'), 'the page keeps its session in the tab')
    // The browser refuses the tab's storage while the page sits in its cache (a privacy setting changed).
    tab.get = () => { throw new Error('SecurityError') }
    const polls = first.pollCount()
    first.fireWindow('pageshow', { persisted: true })
    await waitUntil(() => first.mainText().includes(EN.serveSessionLost), `the restored page ends on the session-lost screen: ${first.mainText()}`)
    for (let round = 0; round < 5; round += 1) { first.runTimers(); await delay(20) }
    assert.equal(first.pollCount(), polls, 'the restored page makes no further poll')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('/api/open waits for the window to load its code only when the request asks, and answers at once otherwise', { timeout: 30_000 }, async () => {
  // The window loads its code 100 ms after the opener says yes (or never, or inside the opener).
  let mode = 'later'
  const board = await startDirectBoard({
    openRedeemMs: 2_000,
    open: async url => {
      const [link] = url.split('#')
      if (mode === 'later') setTimeout(() => { fetch(link).then(res => res.text()).catch(() => {}) }, 100)
      if (mode === 'inside') await (await fetch(link)).text()
      return true
    },
  })
  let failed = false
  try {
    mode = 'later'
    const loaded = await board.call('/api/open', { asApp: true, waitRedeem: true })
    assert.equal(loaded.status, 200)
    assert.equal(loaded.body.isOpen, true)
    assert.equal(loaded.body.isRedeemed, true, 'the window loaded within the wait')

    mode = 'never'
    const startedAt = Date.now()
    const missed = await board.call('/api/open', { asApp: true, waitRedeem: true })
    assert.equal(missed.body.isOpen, true)
    assert.equal(missed.body.isRedeemed, false, 'the window did not load within the wait')
    assert.ok(Date.now() - startedAt >= 1_500, 'the request waited for its window')

    const quickAt = Date.now()
    const quick = await board.call('/api/open', { asApp: true })
    assert.equal(quick.body.isOpen, true)
    assert.equal(quick.body.isRedeemed, false, 'no wait was asked, so the answer is as it stood')
    assert.ok(Date.now() - quickAt < 1_000, 'a request that does not ask for the wait is answered at once')

    mode = 'inside'
    const inside = await board.call('/api/open', { asApp: true })
    assert.equal(inside.body.isRedeemed, true, 'a window that loaded before the answer is reported without any wait')
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

test('a page opened with its token in the address, as main does, still loads and polls', { timeout: 20_000 }, async () => {
  const board = await startDirectBoard()
  let failed = false
  try {
    const res = await fetch(new URL(`/?t=${board.token}`, board.origin))
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.equal(html.includes('id="page-session"'), false, 'the old address carries no page session')
    const page = await runServedPageInOrigin(html, `${board.origin}/?t=${board.token}`, new Map())
    assert.deepEqual(await page.firstBoardPoll, { status: 200, tokenSent: board.token })
    // The command's own calls with the same token still work.
    assert.equal((await board.call('/api/ping')).status, 200)
    // Restored from the browser's cache, such a page keeps polling: its token is in its address.
    const before = page.pollCount()
    page.fireWindow('pageshow', { persisted: true })
    await waitUntil(() => page.pollCount() > before, 'the restored page polls again')
    assert.equal(page.mainText().includes(EN.serveSessionLost), false)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try { await board.close() } catch (cleanupError) { if (!failed) throw cleanupError }
  }
})

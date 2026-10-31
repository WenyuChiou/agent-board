import assert from 'node:assert/strict'
import { spawnIsolated } from './spawn.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { seenWithin, noMachineIds, noSilentPress } from './expect.mjs'
import { PANE_MS } from './budget.mjs'

const pause = ms => new Promise(done => setTimeout(done, ms))
const ownedChildren = new Set()
const ownedServers = new Set()
process.once('exit', () => {
  for (const child of ownedChildren) if (child.exitCode === null && child.signalCode === null) child.kill()
})

export const runProcess = (file, args, options) => new Promise((resolve, reject) => {
  const { input, ...spawnOptions } = options
  const child = spawnIsolated(file, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] })
  ownedChildren.add(child)
  let stdout = '', stderr = '', failure
  const timer = setTimeout(() => {
    failure = new Error(`Driver timed out after 20000 ms: ${file}`)
    child.kill()
  }, 20000)
  child.on('error', error => { failure = error })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('close', (status, signal) => {
    clearTimeout(timer)
    ownedChildren.delete(child)
    if (failure) reject(failure)
    else resolve({ status, signal, stdout, stderr })
  })
  child.stdin.end(input)
})
export const run = (world, args = [], { input, code } = {}) => runProcess(process.execPath,
  code === undefined ? [world.script, ...args] : ['--input-type=module', '-e', code, ...args],
  { env: world.env, cwd: world.root, input },
)
const successful = result => {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}
export const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
export const visibleHtml = source => source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

export const terminal = {
  screen: async (world, args = []) => successful(await run(world, args)),
  keys: async (world, keys, args = []) => successful(await run(world, ['--keys', keys, ...args])),
  watch: world => {
    const preload = world.write('tty.mjs', `Object.defineProperty(process.stdin, 'isTTY', { value: true })\nObject.defineProperty(process.stdout, 'isTTY', { value: true })\nprocess.stdin.setRawMode = () => {}\n`)
    const child = spawnIsolated(process.execPath, ['--import', pathToFileURL(preload).href, world.script, '--watch'], { env: world.env, cwd: world.root, stdio: ['pipe', 'pipe', 'pipe'] })
    ownedChildren.add(child)
    let output = '', errors = '', failure
    let sequence = 0
    const frames = []
    child.on('error', error => { failure = error })
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk
      if (!output.includes('\x1b[H')) return
      const current = output.split('\x1b[H').at(-1)
      const heading = world.lang === 'zh-TW' ? '進度' : world.lang === 'zh-CN' ? '进度' : 'Progress'
      if (!current.includes(heading)) return
      frames.push({ sequence: ++sequence, text: plain(current), at: performance.now() })
    })
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
    const exited = new Promise(done => child.once('close', () => { ownedChildren.delete(child); done() }))
    let isStopped = false
    const watchdog = setTimeout(() => child.kill(), 20000)
    const stop = async () => {
      if (isStopped) return
      isStopped = true
      clearTimeout(watchdog)
      try {
        if (child.exitCode === null) child.kill()
        await exited
        assert.ok(child.exitCode !== null || child.signalCode !== null)
      } finally { child.stdin.destroy() }
    }
    world.cleanups.push(stop)
    return {
      next: async (predicate, ms = PANE_MS) => {
        const first = sequence
        const start = performance.now()
        let found
        await seenWithin(() => {
          if (failure) throw failure
          if (child.exitCode !== null) throw new Error(`Watch exited: ${errors}`)
          found = frames.find(frame => frame.sequence > first && predicate(frame.text))
          return found?.text ?? frames.at(-1)?.text ?? ''
        }, () => found !== undefined, ms)
        return { text: found.text, elapsed: Math.max(0, found.at - start) }
      },
      stop,
      pid: child.pid,
      press: async key => {
        const before = frames.at(-1)?.text ?? ''
        const first = sequence
        child.stdin.write(key)
        await seenWithin(() => frames.at(-1)?.text ?? '', () => sequence > first, PANE_MS)
        const after = frames.at(-1).text
        noSilentPress({ surface: '--watch', card: 'selected row', button: key, before, after })
        return after
      },
    }
  },
}

export const chat = (world, args = []) => run(world, ['--chat', ...args])
export const html = async world => {
  successful(await run(world, ['--html']))
  const text = world.read('progress.html')
  return { text, visible: visibleHtml(text) }
}

// The small DOM is copied from tests/board.test.mjs pageDom. The actual shipped
// page script builds every card and performs every press; tests do not emulate actions.
// The state-first page draws a question as an article.card under Needs you and every task as a
// li.row; cards() returns both, and a row's steps and buttons live inside its own node.
// The page's own parts a person reads: the sidebar, the sections, the notes, the notices and the footer.
const PAGE_PARTS = ['side', 'needs-n', 'board', 'note', 'offline', 'main', '.pfoot']
export const pageDom = async (source, first, post, { clipboard = true, legacyCopy = false } = {}) => {
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
      this.className = ''
    }
    set id(value) {
      this.attributes.id = value
      nodes.set(value, this)
    }
    get id() { return this.attributes.id ?? '' }
    set textContent(value) {
      this.text = value
      this.childNodes = []
    }
    get textContent() { return this.text + this.childNodes.map(child => child.textContent).join(' ') }
    // readText: the words the page holds for the person, leaving out the blocks it keeps only for
    // another state (the empty-board text beside a card, the box for writing an answer). A folded
    // row still counts: its words are one press away, and the privacy checks read them.
    get readText() { return String(this.className).split(' ').includes('gone') ? '' : this.text + this.childNodes.map(child => child.readText).join(' ') }
    // visibleText: only what is on screen now; a closed row and a hidden composer are inert, and a
    // closed details shows its summary only.
    get visibleText() {
      if (this.inert === true) return ''
      const shown = this.tag === 'details' && this.open !== true ? this.childNodes.filter(child => child.tag === 'summary') : this.childNodes
      return this.text + shown.map(child => child.visibleText).join(' ')
    }
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    }
    removeChild(child) { this.childNodes = this.childNodes.filter(one => one !== child) }
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
    remove() { this.parentNode?.removeChild(this) }
    setAttribute(name, value) {
      this.attributes[name] = value
      if (name === 'id') nodes.set(value, this)
    }
    getAttribute(name) { return this.attributes[name] ?? null }
    addEventListener(name, callback) { this.events[name] = callback }
    querySelectorAll(selector = 'textarea[data-key]') {
      return this.childNodes.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    click() {
      if (this.disabled) return
      this.events.click?.()
      if (this.tag === 'summary' && this.parentNode?.tag === 'details') {
        this.parentNode.open = !this.parentNode.open
        this.parentNode.events.toggle?.()
      }
    }
    focus(options) { this.focusOptions = options; document.activeElement = this }
    blur() { if (document.activeElement === this) document.activeElement = null }
    scrollIntoView(options) { (this.scrollCalls ??= []).push(options) }
    select() { this.setSelectionRange(0, this.value.length) }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id))
    return nodes.get(id)
  }
  const matches = (node, selector) => {
    if (selector === 'button') return node.tag === 'button'
    if (selector === 'button:not([data-local])') return node.tag === 'button' && node.getAttribute('data-local') === null
    if (selector === 'button[data-static]') return node.tag === 'button' && node.getAttribute('data-static') !== null
    const tag = selector.match(/^[a-z]+/)?.[0]
    const attrs = [...selector.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/g)]
    if (tag && node.tag !== tag) return false
    if (attrs.length) return attrs.every(([, name, value]) => node.getAttribute(name) !== null && (value === undefined || node.getAttribute(name) === value))
    if (tag) return true
    return selector === 'textarea[data-key]' && node.tag === 'textarea' && node.getAttribute('data-key') !== null
  }
  get('words').textContent = source.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1]
  get('.pfoot').appendChild(get('close'))
  get('close').tag = 'button'
  for (const found of source.matchAll(/<button\b([^>]*)>/g)) {
    const id = found[1].match(/id="([^"]+)"/)?.[1]
    if (!id) continue
    for (const attr of ['data-local', 'data-static']) if (found[1].includes(attr)) get(id).setAttribute(attr, '')
  }
  let model = first, scheduled, pollMs
  const requests = [], copied = []
  const pending = []
  const script = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(code => code.includes('(function ()'))
  const navigator = {}
  const setClipboard = available => { navigator.clipboard = available ? { writeText: async text => { copied.push(text) } } : undefined }
  setClipboard(clipboard)
  const document = {
    body: get('body'),
    execCommand: () => legacyCopy,
    getElementById: get,
    createElement: tag => new Element(tag),
    createTextNode: text => {
      const node = new Element('text')
      node.textContent = text
      return node
    },
    querySelector: selector => selector.startsWith('#') ? get(selector.slice(1)) : [...nodes.values()].flatMap(node => [...(matches(node, selector) ? [node] : []), ...node.querySelectorAll(selector)])[0] ?? get(selector),
    querySelectorAll: selector => [...nodes.values()].flatMap(node => [...(matches(node, selector) ? [node] : []), ...node.querySelectorAll(selector)]),
    addEventListener(name, run) { this.events[name] = run },
    events: {},
    title: '',
    activeElement: null,
  }
  runInNewContext(script, {
    document, location: { search: '?t=synthetic' }, URLSearchParams,
    navigator,
    crypto: { randomUUID }, window: { confirm: () => true, isSecureContext: true },
    setTimeout: (callback, ms) => {
      assert.ok(ms === undefined || Number.isFinite(ms) && ms > 0, 'The shipped page must schedule a poll interval')
      // Only the board's own poll is the next redraw; a short wait of a moving page is not.
      if (ms === 3000 || ms === undefined) {
        pollMs = ms ?? 3000
        scheduled = callback
      }
      return 1
    },
    clearTimeout: () => {},
    fetch: async (target, options) => {
      if (target.startsWith('/api/board')) return { ok: true, json: async () => ({ model, now: 1 }) }
      const request = { path: target, body: JSON.parse(options.body) }
      requests.push(request)
      const promise = post(request)
      pending.push(promise)
      return promise
    },
  }, { timeout: 1000 })
  const flush = async () => {
    await new Promise(done => setImmediate(done))
    await Promise.all(pending)
    await new Promise(done => setImmediate(done))
  }
  await flush()
  const descendants = node => [node, ...node.childNodes.flatMap(descendants)]
  // A question card, a task row, and the line a press leaves where its card has gone (lost).
  const isCard = node => { const names = String(node.className ?? '').split(' '); return names.includes('card') || names.includes('row') || names.includes('lost') }
  return {
    node: get, requests, copied, flush, setClipboard,
    get activeElement() { return document.activeElement },
    get pollMs() { return pollMs },
    inputs: node => descendants(node).filter(one => one.tag === 'textarea'),
    cards: () => descendants(get('board')).filter(isCard),
    buttons: node => descendants(node).filter(one => one.tag === 'button'),
    // The words of one section of the board: needs, working, others or done.
    section: name => get('board').childNodes.filter(one => one.getAttribute('data-sec') === name).map(one => one.readText).join('\n'),
    // The line a press writes next to its card or row.
    slot: node => descendants(node).find(one => String(one.className).split(' ').includes('press-result')),
    redraw: async next => {
      model = next
      scheduled()
      await flush()
    },
    // Puts a button on screen the way a person would: opens the closed shelf, the row and the More
    // panel around it, one press each. False when the page keeps it for another state (a box that
    // shows only after Write your own) or when nothing opens it.
    reveal: button => {
      const toggles = node => descendants(node).filter(one => one.tag === 'button' && one.getAttribute('aria-expanded') === 'false')
      for (let step = 0; step < 8; step++) {
        for (let one = button; one; one = one.parentNode) if (String(one.className).split(' ').includes('gone')) return false
        let folded = null
        for (let one = button; one.parentNode; one = one.parentNode) if (one.parentNode.tag === 'details' && one.parentNode.open !== true && one.tag !== 'summary') folded = one.parentNode
        if (folded) { folded.childNodes.find(one => one.tag === 'summary')?.click(); continue }
        let blocked = null
        for (let one = button; one; one = one.parentNode) if (one.inert === true) blocked = one
        if (!blocked) return true
        let node = blocked, isOpened = false
        for (let level = 0; level < 3 && !isOpened && node.parentNode; level++) {
          const toggle = node.parentNode.childNodes.filter(one => one !== node).flatMap(toggles)[0]
          if (toggle) { toggle.click(); isOpened = true } else node = node.parentNode
        }
        if (!isOpened) return false
      }
      return false
    },
    // text(): the words the page holds for the state it shows, folded away or not (the privacy
    // checks read it); visible(): only what is on screen now (a press must change this).
    text: () => PAGE_PARTS.map(id => get(id).readText).join('\n'),
    visible: () => PAGE_PARTS.map(id => get(id).visibleText).join('\n'),
  }
}

export const serve = {
  // lifetimeMs: how long the kill check waits, from the server's start, before it stops a server
  // nobody stopped; idleMinutes: the page's own idle exit. A long run (the soak) raises both. The
  // default is well past the slowest journey on a slow Windows runner, so a healthy server is
  // never lost mid-journey.
  start: async (world, args = [], { lifetimeMs = 90000, idleMinutes = 5 } = {}) => {
    let pid, timer, url, recordPath, isStopped = false
    // The address file holds a `path` of its own (the progress.md it serves), so the file's own
    // place is kept as `file`, apart from what it holds.
    const records = () => readdirSync(world.root, { recursive: true }).map(String)
      .filter(name => /agent-board-[a-f0-9]+\.json$/.test(name)).flatMap(name => {
        const file = join(world.root, name)
        try { return [{ ...JSON.parse(readFileSync(file, 'utf8')), file }] } catch { return [] }
      })
    const discover = () => {
      const record = records().find(one => url ? one.url === url.href : true)
      if (!record) return
      pid ??= record.pid
      recordPath ??= record.file
      url ??= new URL(record.url)
    }
    const alive = () => {
      if (!Number.isInteger(pid) || pid <= 0) return false
      try { process.kill(pid, 0); return true } catch { return false }
    }
    const isRecorded = () => {
      if (!recordPath || !url) return false
      try {
        const current = JSON.parse(readFileSync(recordPath, 'utf8'))
        return current.pid === pid && current.url === url.href
      } catch { return false }
    }
    const owner = { killRecorded: async () => {
      discover()
      if (!isRecorded() || !alive()) return
      const response = await fetch(new URL('/api/board', url), {
        headers: { 'x-board-token': url.searchParams.get('t') },
        signal: AbortSignal.timeout(1500),
      }).catch(() => undefined)
      // A server that exits between the check and the kill is gone, which is what was wanted.
      if (response?.ok && isRecorded() && alive()) { try { process.kill(pid) } catch {} }
    } }
    ownedServers.add(owner)
    const stop = async () => {
      if (isStopped) return
      clearTimeout(timer)
      discover()
      try {
        if (url) await fetch(new URL('/api/close', url), { method: 'POST', headers: { 'x-board-token': url.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500) }).catch(() => {})
        if (pid) {
          for (let n = 0; n < 30 && alive(); n++) await pause(50)
          // Recheck the record and authenticated endpoint before killing a detached server.
          await owner.killRecorded()
          for (let n = 0; n < 30 && alive(); n++) await pause(50)
          assert.ok(!alive(), `Owned server ${pid} survived teardown`)
        }
        isStopped = true
      } finally { ownedServers.delete(owner) }
    }
    world.cleanups.push(stop)
    try {
      const output = await terminal.screen(world, ['--serve', '--no-open', '--idle-minutes', String(idleMinutes), ...args])
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)
      assert.ok(match, output)
      url = new URL(match[0])
      discover()
      assert.ok(pid && recordPath, 'The isolated runtime owns its server address file')
      timer = setTimeout(() => { void owner.killRecorded().catch(() => {}) }, lifetimeMs)
      const call = async (method, path, body) => {
        const response = await fetch(new URL(path, url), { method, headers: { 'x-board-token': url.searchParams.get('t'), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) })
        const text = await response.text()
        return { status: response.status, body: text, json: () => JSON.parse(text) }
      }
      const get = path => call('GET', path)
      const post = (path, body) => call('POST', path, body)
      let dom
      const page = async () => {
        const model = (await get('/api/board')).json().model
        if (!dom) dom = await pageDom((await get(url.pathname + url.search)).body, model, async request => {
          const result = await post(request.path, request.body)
          return { ok: result.status < 400, json: async () => result.json() }
        })
        else await dom.redraw(model)
        return dom.text()
      }
      const matches = (value, pattern) => pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern)
      // A button that only opens or reveals (a row's head, More) is no action and is not pressed here.
      const isAction = one => one.getAttribute('data-nav') === null
      // A button of the page itself, in no card or row (the Done shelf's Archive now).
      const pressPage = async buttonMatch => {
        await page()
        const button = dom.buttons(dom.node('board')).find(one => isAction(one) && matches(one.textContent, buttonMatch))
        assert.ok(button, `Button missing: ${buttonMatch}\n${dom.text()}`)
        assert.ok(dom.reveal(button), `Button not on screen: ${buttonMatch}\n${dom.text()}`)
        const before = dom.visible()
        button.click()
        await dom.flush()
        await page()
        return { before, after: dom.visible(), card: 'page', button: button.textContent, surface: 'serve', requests: dom.requests }
      }
      const press = async (cardMatch, buttonMatch) => {
        await page()
        const card = dom.cards().find(one => matches(one.textContent, cardMatch) && dom.buttons(one).some(button => isAction(button) && matches(button.textContent, buttonMatch)))
        assert.ok(card, `Card missing: ${cardMatch}\n${dom.text()}`)
        const button = dom.buttons(card).find(one => isAction(one) && matches(one.textContent, buttonMatch))
        assert.ok(button, `Button missing: ${buttonMatch}\n${card.textContent}`)
        // A person opens the shelf and the row first, and a press must change what is on screen.
        assert.ok(dom.reveal(button), `Button not on screen: ${buttonMatch}\n${card.textContent}`)
        const before = card.visibleText
        button.click()
        await dom.flush()
        await page()
        const after = dom.cards().find(one => matches(one.textContent, cardMatch) && dom.buttons(one).some(button => isAction(button) && matches(button.textContent, buttonMatch)))?.visibleText ?? ''
        return { before, after, card: String(cardMatch), button: button.textContent, surface: 'serve', requests: dom.requests }
      }
      // isOwned: the pid is alive and the world's address file still names it and this address. It
      // does not ask the server, so after a hard crash a leftover file and a reused pid would pass:
      // a caller that ends the server itself first asks it (as killRecorded and the soak do).
      const visible = async () => { await page(); return dom.visible() }
      return { url: url.href, get, post, page, visible, press, pressPage, stop, pid, isOwned: () => isRecorded() && alive(), get dom() { return dom }, get pollMs() { return dom?.pollMs } }
    } catch (error) {
      await stop()
      throw error
    }
  },
}

export const inspectSurfaces = async (world, server, { allow = [] } = {}) => {
  const ownsServer = !server
  let watch
  try {
    server ??= await serve.start(world)
    watch = terminal.watch(world)
    // Startup includes loading Node and the bundle. Event timing starts only
    // after a ready frame, in the journeys that then write or answer a task.
    const frame = await watch.next(() => true, 10000)
    const [terminalText, pageText, htmlText, chatResult] = await Promise.all([
      terminal.screen(world), server.page(), html(world), chat(world),
    ])
    const screens = { terminal: terminalText, watch: frame.text, page: pageText, html: htmlText.visible, chat: chatResult.stdout }
    for (const text of Object.values(screens)) noMachineIds(text, world, { allow })
    return screens
  } finally {
    await watch?.stop()
    if (ownsServer) await server?.stop()
  }
}

// visible: read only what is on screen (a folded row and a hidden box do not count).
// read: a function that returns the text to test, in place of the whole page.
export const seenPageWithin = async (server, predicate, ms, { visible = false, read } = {}) => {
  // pageDom advances the shipped poll callback without sleeping; charge its actual delay.
  if (server.pollMs === undefined) await server.page()
  const pollMs = server.pollMs
  assert.ok(Number.isFinite(pollMs) && pollMs < ms, `Page poll ${pollMs} exceeds budget ${ms}`)
  return pollMs + await seenWithin(read ?? (visible ? server.visible : server.page), predicate, ms - pollMs)
}

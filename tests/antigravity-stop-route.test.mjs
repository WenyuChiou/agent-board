import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { bundleFromDir } from '../scripts/bundle-text.mjs'
import { hookOrDeferred } from './helpers/deferred-turn.mjs'

// Route H continuation delivery on agy TUI StopWait hooks (#1841).
// Tests run the built board script and hook worker against isolated temp directories
// and an in-process loopback HTTP stand-in; no live Antigravity calls run here.
const session = 'synthetic-agy-stop-route-session'

const importTs = async path => {
  const resolver = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  } })
  try { return await import(path) } finally { resolver.deregister() }
}

const tsMod = await (async () => ({
  ...await importTs('../scripts/runtime-folder.ts'),
  ...await importTs('../hooks/hook-messages.ts'),
  ...await importTs('../hooks/messaging.ts'),
  ...await importTs('../hooks/local-agents.ts'),
  ...await importTs('../hooks/hook-safety.ts'),
  ...await importTs('../scripts/board-messaging.ts'),
  ...await importTs('../hooks/sha256.ts'),
}))()

const fixture = async (folder, fn) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-stop-route-'))
  const servers = []
  const children = new Set()
  try {
    const root = join(home, '.agent-board')
    const script = join(root, 'agent-board.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(script, bundleFromDir(new URL('..', import.meta.url)))
    const progress = join(root, 'progress.md')
    writeFileSync(progress, '')
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, LANG: 'en', CI: '1', NO_COLOR: '1', AGENT_BOARD_SETUP_COMMAND: '',
      AGENT_BOARD_TEST_PID: String(process.pid), XDG_RUNTIME_DIR: join(home, 'runtime'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    }
    const directory = tsMod.defaultMessagesDirectory(progress, home, env, process.platform)
    const transcript = join(home, '.gemini', folder, 'brain', 'synthetic-conversation', '.system_generated', 'logs', 'transcript.jsonl')
    const ownerHash = tsMod.sha256(`antigravity:${session}`)

    const call = (event, fields = {}, opts = {}) => spawnSync(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress,
      '--agent', 'antigravity', '--agent-status', '--state', event === 'SessionStart' || event === 'Stop' || event === 'StopWait' ? 'waiting' : 'working', '--event', event,
      ...(opts.deadlineMs ? ['--hook-deadline', String(Date.now() + opts.deadlineMs)] : []),
    ], {
      cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: opts.timeout ?? 15000,
      input: JSON.stringify({ conversationId: session, hook_event_name: event === 'StopWait' ? 'Stop' : event, transcriptPath: transcript, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, executionNum: 0, ...fields }),
    })

    const spawnAsync = (event, fields = {}, opts = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--home', home, '--data-dir', root, '--progress-file', progress,
        '--agent', 'antigravity', '--agent-status', '--state', 'waiting', '--event', event,
        '--hook-deadline', String(Date.now() + (opts.deadlineMs ?? 6000)),
      ], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      children.add(child)
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      child.on('error', err => { children.delete(child); reject(err) })
      child.on('close', (status, signal) => { children.delete(child); resolve({ status, signal, stdout, stderr }) })
      child.stdin.end(JSON.stringify({ conversationId: session, hook_event_name: 'Stop', transcriptPath: transcript, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, executionNum: 0, ...fields }))
    })

    const state = () => JSON.parse(readFileSync(join(directory, 'messages.json'), 'utf8'))
    const seed = (id, surface = 'agy TUI', text = 'Synthetic board reply') => {
      let current
      try { current = state() } catch { current = { messages: [] } }
      const now = Date.now()
      const enrolled = tsMod.enrollMailbox(current, 'antigravity', session, surface, now, 43_200_000)
      const target = enrolled.mailboxes.find(one => one.agent === 'antigravity' && one.session === session)
      const queued = tsMod.queueMessage(enrolled, { id, target: target.id, turn: 'session', text }, 'board', target, now).state
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'messages.json'), JSON.stringify({ version: 2, ...queued }))
    }
    const one = id => state().messages.find(message => message.id === id)
    const writeWaitingBlock = (blockSession = ownerHash.slice(0, 8), resume = session) => {
      const id = blockSession
      writeFileSync(progress, [
        '## Synthetic',
        `<!-- auto session=${id} agent=antigravity source=antigravity-local owner=${ownerHash} state=waiting updated=${new Date().toISOString()} resume=${resume} -->`,
        '### Synthetic agy question',
        '- [?] Blue or green?',
        `<!-- /auto session=${id} -->`,
        '',
      ].join('\n'))
    }
    const append = (...entries) => {
      mkdirSync(dirname(transcript), { recursive: true })
      appendFileSync(transcript, entries.map(line => JSON.stringify(line)).join('\n') + '\n')
    }
    const say = (...replies) => append(
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Synthetic prompt' },
      ...replies.map(content => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', content })),
    )

    const startStandInServer = async (initialPageAgo = 500) => {
      const token = 'synth-token-1841'
      let pageAgo = initialPageAgo
      let store = { messages: [] }
      const mailboxTurnCalls = []
      const now = Date.now()
      const enrolled = tsMod.enrollMailbox(store, 'antigravity', session, 'agy TUI', now, 43_200_000)
      store = enrolled
      const server = createServer((req, res) => {
        if (req.url === '/api/ping' && req.method === 'GET') {
          if (req.headers['x-board-token'] !== token) { res.writeHead(403); return res.end('{}') }
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ pageAgo }))
        }
        if (req.url?.startsWith('/api/messages/') && req.method === 'POST') {
          if (req.headers['x-board-token'] !== token) { res.writeHead(403); return res.end('{}') }
          const action = req.url.slice('/api/messages/'.length)
          let bodyText = ''
          req.on('data', chunk => { bodyText += chunk })
          req.on('end', () => {
            try {
              const body = JSON.parse(bodyText || '{}')
              const out = tsMod.mailboxAction(store, action, body, Date.now())
              store = out.state
              if (action === 'mailbox-turn') mailboxTurnCalls.push({ at: Date.now(), hasMessage: out.result.message !== null })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify(out.result))
            } catch (err) {
              res.writeHead(409, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'ERR' }))
            }
          })
          return
        }
        res.writeHead(404); res.end('{}')
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      servers.push(server)
      const { port } = server.address()
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'server.lock'), String(process.pid))
      writeFileSync(join(directory, 'server.owner'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/?t=${token}` }))
      return {
        queueReply: (id, text) => {
          const t = Date.now()
          const target = store.mailboxes.find(m => m.agent === 'antigravity' && m.session === session)
          store = tsMod.queueMessage(store, { id, target: target.id, turn: 'session', text }, 'board', target, t).state
        },
        setPageAgo: next => { pageAgo = next },
        storeState: () => store,
        mailboxTurnCalls,
      }
    }

    await fn({ home, root, script, progress, directory, transcript, env, call, spawnAsync, seed, state, one, writeWaitingBlock, say, append, startStandInServer })
  } finally {
    for (const child of children) { try { child.kill('SIGKILL') } catch {} }
    for (const server of servers) { try { await new Promise(resolve => server.close(resolve)) } catch {} }
    try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch {}
  }
}

test('StopWait claims queued message on agy TUI and saves AckClaim with fromSize', () => fixture('antigravity-cli', async f => {
  f.say('Turn 1 question: Blue or green?')
  f.seed('msg-immediate', 'agy TUI', 'Choose Blue')
  const res = f.call('StopWait')
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.decision, 'continue')
  assert.match(out.reason, /Choose Blue/)
  const msg = f.one('msg-immediate')
  assert.equal(msg.status, 'accepted')
  assert.match(out.reason, new RegExp(`ACK ${msg.nonce}`))
}))

test('Stop Handler 1 acknowledges ACK nonce from transcript after StopWait claim', () => fixture('antigravity-cli', async f => {
  f.say('Turn 1 question: Blue or green?')
  f.seed('msg-ack-loop', 'agy TUI', 'Choose Blue')
  const waitRes = f.call('StopWait')
  assert.equal(waitRes.status, 0, waitRes.stderr)
  const out = JSON.parse(waitRes.stdout.trim())
  assert.equal(out.decision, 'continue')
  const nonce = f.one('msg-ack-loop').nonce
  f.say(`ACK ${nonce}\nChosen: Blue.`)
  const stop1 = f.call('Stop')
  assert.equal(stop1.status, 0, stop1.stderr)
  if (f.one('msg-ack-loop').status !== 'acknowledged') {
    const retry = f.call('Stop')
    assert.equal(retry.status, 0, retry.stderr)
  }
  assert.equal(f.one('msg-ack-loop').status, 'acknowledged')
  assert.equal(f.one('msg-ack-loop').reply, `ACK ${nonce}`)
}))

test('StopWait waits on active page without holding claim until board reply arrives', () => fixture('antigravity-cli', async f => {
  f.say('Blue or green?')
  f.writeWaitingBlock()
  const srv = await f.startStandInServer(100)
  const started = Date.now()
  const pendingHook = f.spawnAsync('StopWait', {}, { deadlineMs: 8000 })
  await new Promise(r => setTimeout(r, 350))
  assert.equal(srv.storeState().messages.length, 0, 'no claim exists before reply is queued')
  assert.ok(srv.mailboxTurnCalls.some(c => !c.hasMessage), 'polled while waiting without holding claim')
  srv.queueReply('msg-waited', 'Blue please')
  const res = await pendingHook
  const elapsed = Date.now() - started
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout.trim())
  assert.equal(out.decision, 'continue')
  assert.match(out.reason, /Blue please/)
  assert.equal(srv.storeState().messages.find(m => m.id === 'msg-waited')?.status, 'accepted')
  assert.ok(elapsed < 4000, `expected prompt wake after queue, got ${elapsed}ms`)
}))

test('StopWait fast-exits empty object when progress has no waiting step for session', () => fixture('antigravity-cli', async f => {
  f.say('Done without question.')
  await f.startStandInServer(100)
  const t0 = Date.now()
  const res = f.call('StopWait', {}, { deadlineMs: 5000 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.ok(Date.now() - t0 < 2000, 'must fast-exit without waiting loop')
}))

test('StopWait fast-exits empty object when no board server is running', () => fixture('antigravity-cli', async f => {
  f.say('Blue or green?')
  f.writeWaitingBlock()
  const t0 = Date.now()
  const res = f.call('StopWait', {}, { deadlineMs: 5000 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.ok(Date.now() - t0 < 2000, 'must fast-exit without running board server')
}))

test('StopWait fast-exits empty object when ping returns null pageAgo', () => fixture('antigravity-cli', async f => {
  f.say('Blue or green?')
  f.writeWaitingBlock()
  await f.startStandInServer(null)
  const t0 = Date.now()
  const res = f.call('StopWait', {}, { deadlineMs: 5000 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.ok(Date.now() - t0 < 2000, 'must fast-exit when no visible page loaded')
}))

test('StopWait fast-exits empty object when ping returns stale pageAgo over 30000', () => fixture('antigravity-cli', async f => {
  f.say('Blue or green?')
  f.writeWaitingBlock()
  await f.startStandInServer(35000)
  const t0 = Date.now()
  const res = f.call('StopWait', {}, { deadlineMs: 5000 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.ok(Date.now() - t0 < 2000, 'must fast-exit when page hidden > 30 s')
}))

test('StopWait exits empty object without claim when wait deadline expires with no reply', () => fixture('antigravity-cli', async f => {
  f.say('Blue or green?')
  f.writeWaitingBlock()
  const srv = await f.startStandInServer(100)
  const res = f.call('StopWait', {}, { deadlineMs: 1800, timeout: 10000 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(srv.storeState().messages.length, 0)
}))

test('StopWait exits empty object immediately on IDE antigravity path without claiming', () => fixture('antigravity', async f => {
  f.seed('msg-ide-1', 'IDE', 'Should wait for next turn')
  const res = f.call('StopWait')
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-ide-1').status, 'queued')
}))

test('StopWait exits empty object immediately on IDE antigravity-ide path without claiming', () => fixture('antigravity-ide', async f => {
  f.seed('msg-ide-2', 'IDE', 'Should wait for next turn')
  const res = f.call('StopWait')
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-ide-2').status, 'queued')
}))

test('StopWait exits empty object immediately on unknown path without claiming', () => fixture('other-client', async f => {
  f.seed('msg-unknown', 'agy TUI', 'Should stay queued')
  const res = f.call('StopWait', { transcriptPath: join(f.home, 'outside', 'transcript.jsonl'), artifactDirectoryPath: undefined })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-unknown').status, 'queued')
}))

test('StopWait exits empty object when terminationReason is not NO_TOOL_CALL', () => fixture('antigravity-cli', async f => {
  f.seed('msg-term', 'agy TUI', 'Ignored on non-NO_TOOL_CALL')
  for (const reason of ['USER_CANCELED', 'ERROR', 'MAX_INVOCATIONS']) {
    const res = f.call('StopWait', { terminationReason: reason })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout.trim()), {})
    assert.equal(f.one('msg-term').status, 'queued', reason)
  }
}))

test('StopWait exits empty object when payload has non-empty error', () => fixture('antigravity-cli', async f => {
  f.seed('msg-error', 'agy TUI', 'Ignored on error')
  const res = f.call('StopWait', { error: 'boom' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-error').status, 'queued')
}))

test('StopWait exits empty object when fullyIdle is false', () => fixture('antigravity-cli', async f => {
  f.seed('msg-not-idle', 'agy TUI', 'Ignored while not idle')
  const res = f.call('StopWait', { fullyIdle: false })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-not-idle').status, 'queued')
}))

test('StopWait exits empty object when executionNum reaches loop guard limit', () => fixture('antigravity-cli', async f => {
  f.seed('msg-loop-cap', 'agy TUI', 'Ignored at executionNum 8')
  const res = f.call('StopWait', { executionNum: 8 })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-loop-cap').status, 'queued')
}))

test('StopWait never delivers a message already claimed by PreInvocation', () => fixture('antigravity-cli', async f => {
  f.seed('msg-already-claimed', 'agy TUI', 'Already delivered')
  await hookOrDeferred(() => f.call('PreInvocation'), () => f.one('msg-already-claimed').status === 'accepted')
  assert.equal(f.one('msg-already-claimed').status, 'accepted')
  const res = f.call('StopWait')
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout.trim()), {})
  assert.equal(f.one('msg-already-claimed').status, 'accepted')
}))

test('antigravityHooks emits sequential Stop and StopWait entries while keeping base timeout 3000', () => {
  assert.equal(tsMod.HOOK_TIMEOUTS.antigravity.timeout, 3000)
  assert.equal(tsMod.hostHookTimeout('antigravity', 'Stop'), 3)
  assert.equal(tsMod.hostHookTimeout('antigravity', 'StopWait'), 30)
  const hooks = tsMod.antigravityHooks((event, state) => `node hook.mjs --hook-event ${event} --event ${event} --state ${state}`)
  assert.equal(Array.isArray(hooks.Stop), true)
  assert.equal(hooks.Stop.length, 2)
  assert.equal(hooks.Stop[0].timeout, 3)
  assert.match(hooks.Stop[0].command, /--hook-event Stop\b/)
  assert.equal(hooks.Stop[1].timeout, 30)
  assert.match(hooks.Stop[1].command, /--hook-event StopWait\b/)
})

test('StopWait worker timeout fails open with empty object exit 0 and skips pending queue', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-stop-worker-timeout-'))
  try {
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const fakeScript = join(root, 'fake-board.mjs')
    const worker = join(root, 'agent-board-hook.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(progress, '')
    writeFileSync(fakeScript, `globalThis.AGENT_BOARD = {"hookVersion":${tsMod.HOOK_VERSION},"x":1}\nsetTimeout(() => {}, 10000)\n`)
    writeFileSync(worker, tsMod.hookWorker(home, fakeScript, 'const isBoardRequest = () => false; const isDeliveryRequest = () => false;'))
    const deadline = Date.now() + 300
    const res = spawnSync(process.execPath, [
      worker, '--hook-version', String(tsMod.HOOK_VERSION), '--hook-event', 'StopWait', '--hook-deadline', String(deadline),
      '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'StopWait', '--progress-file', progress,
    ], { cwd: home, encoding: 'utf8', windowsHide: true, timeout: 10000, input: JSON.stringify({ conversationId: session, hook_event_name: 'Stop' }) })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout.trim()), {})
    const pendingDir = join(root, 'pending')
    const queued = existsSync(pendingDir) ? readdirSync(pendingDir).filter(name => name.endsWith('.json')) : []
    assert.deepEqual(queued, [])
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch {}
  }
})

test('StopWait worker error fails open with empty object exit 0 and skips pending queue', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-stop-worker-error-'))
  try {
    const root = join(home, '.agent-board')
    const progress = join(root, 'progress.md')
    const fakeScript = join(root, 'fake-board.mjs')
    const worker = join(root, 'agent-board-hook.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(progress, '')
    writeFileSync(fakeScript, `globalThis.AGENT_BOARD = {"hookVersion":${tsMod.HOOK_VERSION},"x":1}\nprocess.stderr.write('failed (EBUSY)\\n')\nprocess.exit(1)\n`)
    writeFileSync(worker, tsMod.hookWorker(home, fakeScript, 'const isBoardRequest = () => false; const isDeliveryRequest = () => false;'))
    const res = spawnSync(process.execPath, [
      worker, '--hook-version', String(tsMod.HOOK_VERSION), '--hook-event', 'StopWait', '--hook-deadline', String(Date.now() + 5000),
      '--agent-status', '--agent', 'antigravity', '--state', 'waiting', '--event', 'StopWait', '--progress-file', progress,
    ], { cwd: home, encoding: 'utf8', windowsHide: true, timeout: 10000, input: JSON.stringify({ conversationId: session, hook_event_name: 'Stop' }) })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout.trim()), {})
    const pendingDir = join(root, 'pending')
    const queued = existsSync(pendingDir) ? readdirSync(pendingDir).filter(name => name.endsWith('.json')) : []
    assert.deepEqual(queued, [])
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch {}
  }
})

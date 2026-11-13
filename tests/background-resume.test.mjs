import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { suite, test } from 'node:test'

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

const { EN } = await import('../hooks/strings-en.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { SURFACE_IDS, claimMessages, enrollMailbox, queueMessage, sendDecision, shownMessage } = await import('../hooks/messaging.ts')
const { enrollMailbox: initMailbox } = await import('../hooks/hook-messages.ts')
const { routeText, serveModel, servePage } = await import('../hooks/serve.ts')
const { checkLiveResumeRecord, disallowedPermissionFlag, isLoopbackUrl, parseResumeOutput, runBackgroundResume, runSendPlan } = await import('../scripts/background-resume.ts')
const { createMessaging } = await import('../scripts/board-messaging.ts')
const { pageDom } = await import('./e2e/lib/surfaces.mjs')

const RECORDED_REOPEN_ROUTES = [
  {
    agent: 'cursor',
    kind: 'live',
    routes: {
      idle: { line: 'reopen', record: 'docs/validation/synthetic-cursor-reopen.md', surfaces: [SURFACE_IDS.cli] },
      working: { line: 'none', record: null, surfaces: [] },
      ended: { line: 'reopen', record: 'docs/validation/synthetic-cursor-reopen.md', surfaces: [SURFACE_IDS.cli] },
    },
  },
]

const UNRECORDED_REOPEN_ROUTES = [
  {
    agent: 'cursor',
    kind: 'live',
    routes: {
      idle: { line: 'reopen', record: null, surfaces: [] },
      working: { line: 'none', record: null, surfaces: [] },
      ended: { line: 'reopen', record: null, surfaces: [] },
    },
  },
]

const writeFakeCli = (dir, body) => {
  const file = join(dir, 'fake-ai.mjs')
  writeFileSync(file, body, 'utf8')
  try {
    chmodSync(file, 0o755)
  } catch {}
  return file
}

const makeTempDir = () => mkdtempSync(join(tmpdir(), 'ab-1402-'))

test('isLoopbackUrl accepts loopback HTTP board addresses and rejects LAN or external URLs', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:4123/?t=secret'), true)
  assert.equal(isLoopbackUrl('http://localhost:4123/?t=secret'), true)
  assert.equal(isLoopbackUrl('http://[::1]:4123/?t=secret'), true)
  assert.equal(isLoopbackUrl('http://192.168.1.44:4123/?t=secret'), false)
  assert.equal(isLoopbackUrl('http://10.0.0.5:4123/?t=secret'), false)
  assert.equal(isLoopbackUrl('https://127.0.0.1:4123/?t=secret'), false)
  assert.equal(isLoopbackUrl('http://user:pass@127.0.0.1:4123/?t=secret'), false)
  assert.equal(isLoopbackUrl('http://127.0.0.1/?t=secret'), false)
  assert.equal(isLoopbackUrl('not-a-url'), false)
})

test('disallowedPermissionFlag detects wider permission modes and allows default flags', () => {
  assert.equal(disallowedPermissionFlag(['cursor-agent', '--resume', 'abc-123']), null)
  assert.equal(disallowedPermissionFlag(['codex', 'exec', 'resume', '--skip-git-repo-check', 'abc-123', '-']), null)
  assert.equal(disallowedPermissionFlag(['cursor-agent', '--resume', '--yolo']), '--yolo')
  assert.equal(disallowedPermissionFlag(['claude', '--dangerously-skip-permissions', '--resume']), '--dangerously-skip-permissions')
  assert.equal(disallowedPermissionFlag(['codex', '--full-auto', 'resume']), '--full-auto')
  assert.equal(disallowedPermissionFlag(['cursor-agent', '--permission-mode=bypassPermissions']), '--permission-mode=bypassPermissions')
  assert.equal(disallowedPermissionFlag(['codex', '--approval-mode', 'never']), '--approval-mode')
  assert.equal(disallowedPermissionFlag(['hermes', '--auto-approve']), '--auto-approve')
  assert.equal(disallowedPermissionFlag(['hermes', '-y']), '-y')
  assert.equal(disallowedPermissionFlag(['cursor-agent', '--resume', '--', '--yolo']), null)
})

test('parseResumeOutput extracts exact ACK line and single-line reply summary', () => {
  const separate = parseResumeOutput('ACK abc123\nFixed the config.\nAll tests pass.\n', 'abc123')
  assert.equal(separate.ack, 'ACK abc123')
  assert.equal(separate.reply, 'Fixed the config. All tests pass.')
  assert.equal(separate.receiptReply, 'ACK abc123 Fixed the config. All tests pass.')

  const inline = parseResumeOutput('Thinking...\nACK abc123 Ready in your window.\n', 'abc123')
  assert.equal(inline.ack, 'ACK abc123 Ready in your window.')
  assert.equal(inline.reply, 'Ready in your window.')
  assert.equal(inline.receiptReply, 'ACK abc123 Ready in your window.')

  const missing = parseResumeOutput('Done without ACK line.\n', 'abc123')
  assert.equal(missing.ack, null)
  assert.equal(missing.reply, 'Done without ACK line.')
  assert.equal(missing.receiptReply, null)
})

suite('background resume CLI stand-in', { concurrency: 1 }, () => {
test('owner limits: refused off loopback (LAN flag and non-loopback URL) without spawning', async () => {
  const dir = makeTempDir()
  const marker = join(dir, 'spawned.txt')
  const script = writeFakeCli(dir, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`)
  const previous = process.env.AGENT_BOARD_CURSOR
  process.env.AGENT_BOARD_CURSOR = script
  try {
    const receipts = []
    const onLan = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-lan', text: 'Continue', nonce: '112233' }, isLan: true, state: 'idle', routes: RECORDED_REOPEN_ROUTES, recordReceipt: r => { receipts.push(r) }, s: EN },
    )
    assert.equal(onLan.ok, false)
    assert.equal(onLan.started, false)
    assert.equal(onLan.status, 'rejected')
    assert.equal(onLan.error, 'LOOPBACK_ONLY')

    const offLoopback = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-remote', text: 'Continue', nonce: '112233' }, boardUrl: 'http://192.168.1.9:4312/?t=tok', state: 'idle', routes: RECORDED_REOPEN_ROUTES, recordReceipt: r => { receipts.push(r) }, s: EN },
    )
    assert.equal(offLoopback.ok, false)
    assert.equal(offLoopback.started, false)
    assert.equal(offLoopback.status, 'rejected')
    assert.equal(offLoopback.error, 'LOOPBACK_ONLY')
    assert.equal(existsSync(marker), false)
    assert.equal(receipts.length, 2)
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOARD_CURSOR
    else process.env.AGENT_BOARD_CURSOR = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('owner limits: refused on non-default permission mode flags without spawning', async () => {
  const dir = makeTempDir()
  const marker = join(dir, 'spawned.txt')
  const script = writeFakeCli(dir, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`)
  const previous = process.env.AGENT_BOARD_CURSOR
  process.env.AGENT_BOARD_CURSOR = script
  try {
    for (const extraArgs of [['--yolo'], ['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--full-auto']]) {
      const outcome = await runBackgroundResume(
        { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli, extraArgs },
        { message: { id: 'm-perm', text: 'Continue', nonce: 'abc111' }, isLan: false, state: 'idle', routes: RECORDED_REOPEN_ROUTES, s: EN },
      )
      assert.equal(outcome.ok, false)
      assert.equal(outcome.started, false)
      assert.equal(outcome.status, 'rejected')
      assert.equal(outcome.error, 'PERMISSION_MODE_DISALLOWED')
    }
    const planOutcome = await runSendPlan({ agent: 'codex', command: 'codex', args: ['exec', 'resume', '--full-auto', '11111111-2222-4333-8444-555555555555', '-'], stdin: 'Hi', cwd: dir, isShell: false }, EN, 'Codex')
    assert.equal(planOutcome.ok, false)
    assert.ok(planOutcome.note.includes(EN.servePermissionRestricted))
    assert.equal(existsSync(marker), false)
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOARD_CURSOR
    else process.env.AGENT_BOARD_CURSOR = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('owner limits: refused mid-turn (working state, running flag, active turn lock, unknown state)', async () => {
  const dir = makeTempDir()
  const marker = join(dir, 'spawned.txt')
  const script = writeFakeCli(dir, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`)
  const previous = process.env.AGENT_BOARD_CURSOR
  process.env.AGENT_BOARD_CURSOR = script
  try {
    const workingState = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-work', text: 'Continue', nonce: 'aabbcc' }, state: 'working', routes: RECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(workingState.ok, false)
    assert.equal(workingState.error, 'TURN_IN_PROGRESS')
    assert.equal(workingState.started, false)

    const runningFlag = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-flag', text: 'Continue', nonce: 'aabbcc' }, state: 'idle', isTurnRunning: true, routes: RECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(runningFlag.ok, false)
    assert.equal(runningFlag.error, 'TURN_IN_PROGRESS')

    const activeTurns = new Set(['cursor:conv-1234'])
    const concurrentTurn = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-lock', text: 'Continue', nonce: 'aabbcc' }, state: 'idle', activeTurns, routes: RECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(concurrentTurn.ok, false)
    assert.equal(concurrentTurn.error, 'TURN_IN_PROGRESS')

    const unknownState = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-unk', text: 'Continue', nonce: 'aabbcc' }, state: undefined, routes: RECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(unknownState.ok, false)
    assert.equal(unknownState.error, 'STATE_UNKNOWN')
    assert.equal(existsSync(marker), false)

    // sendDecision also blocks a reopen route while the session is working, even if misconfigured.
    const misconfigured = [{ agent: 'cursor', kind: 'live', routes: { idle: { line: 'reopen', record: 'docs/validation/x.md', surfaces: [SURFACE_IDS.cli] }, working: { line: 'reopen', record: 'docs/validation/x.md', surfaces: [SURFACE_IDS.cli] }, ended: { line: 'none', record: null, surfaces: [] } } }]
    const target = { id: 'conn-1', agent: 'cursor', session: 'conv-1234', surface: SURFACE_IDS.cli, turn: 'session', scope: 'session', expires: 1000 }
    const decision = sendDecision('conn-1', [target], [], () => 'working', misconfigured, 500)
    assert.equal(decision.canSend, false)
    assert.equal(decision.reason, 'TURN_RUNNING')
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOARD_CURSOR
    else process.env.AGENT_BOARD_CURSOR = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('owner limits: live record required before helper spawns or card offers Send', async () => {
  const dir = makeTempDir()
  const marker = join(dir, 'spawned.txt')
  const script = writeFakeCli(dir, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`)
  const previous = process.env.AGENT_BOARD_CURSOR
  process.env.AGENT_BOARD_CURSOR = script
  try {
    const unrecorded = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'm-unrec', text: 'Continue', nonce: 'dd1122' }, state: 'idle', routes: UNRECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(unrecorded.ok, false)
    assert.equal(unrecorded.error, 'NO_RECORDED_ROUTE')
    assert.equal(existsSync(marker), false)

    assert.equal(checkLiveResumeRecord('cursor', 'idle', RECORDED_REOPEN_ROUTES, SURFACE_IDS.cli).ok, true)
    assert.equal(checkLiveResumeRecord('cursor', 'idle', UNRECORDED_REOPEN_ROUTES, SURFACE_IDS.cli).ok, false)
    assert.equal(checkLiveResumeRecord('cursor', 'working', RECORDED_REOPEN_ROUTES, SURFACE_IDS.cli).ok, false)

    const now = Date.now()
    const file = `## Demo\n<!-- auto session=abcdef01 agent=cursor resume=conv-1234 state=waiting updated=${new Date(now).toISOString()} -->\n### Background resume check\n- [?] Continue?\n<!-- /auto session=abcdef01 -->\n`
    const view = buildView(parseProgress(file), [], null, now, 0, {}, EN)
    const connections = [{ id: 'conn-cursor', agent: 'cursor', session: 'conv-1234', surface: SURFACE_IDS.cli, turn: 'session', scope: 'session', expires: now + 60_000 }]
    const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }

    const copyModel = serveModel(view, [], EN, new Set(), false, { connections, mailboxes: [], messages: [] }, false, group, UNRECORDED_REOPEN_ROUTES)
    assert.equal(copyModel.asks[0].send, 'none')
    assert.equal(copyModel.asks[0].delivery, undefined)

    const sendModel = serveModel(view, [], EN, new Set(), false, { connections, mailboxes: [], messages: [] }, false, group, RECORDED_REOPEN_ROUTES)
    assert.equal(sendModel.asks[0].send, 'connected')
    assert.equal(sendModel.asks[0].line, 'reopen')
    assert.ok(sendModel.asks[0].delivery !== undefined)
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOARD_CURSOR
    else process.env.AGENT_BOARD_CURSOR = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('runs resume CLI in background, reads reply and ACK line, records receipt, and handles missing ACK or timeout', async () => {
  const dir = makeTempDir()
  const storeDir = join(dir, 'messages')
  const recordedCall = join(dir, 'call.json')
  const script = writeFakeCli(dir, `
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(${JSON.stringify(recordedCall)}, JSON.stringify({ args, cwd: process.cwd() }))
if (args.at(-1)?.includes('MISSING_ACK')) {
  console.log('Ran without printing the ack code')
  process.exit(0)
}
if (args.at(-1)?.includes('SLOW_TURN')) {
  setTimeout(() => console.log('too late'), 10000)
} else {
  const match = /ACK ([0-9a-f]+)/.exec(args.at(-1) || '')
  console.log('ACK ' + match[1])
  console.log('Updated config.json in workspace.')
}
`)
  const previous = process.env.AGENT_BOARD_CURSOR
  process.env.AGENT_BOARD_CURSOR = script
  let messaging
  try {
    messaging = createMessaging(storeDir, false, { routes: RECORDED_REOPEN_ROUTES, stateOfSession: () => 'idle' })
    const now = Date.now()
    const registered = messaging.act('register', { agent: 'cursor', session: 'conv-1234', surface: SURFACE_IDS.cli, turn: 'session', scope: 'session' }, now)
    const sent = messaging.act('send', { id: 'msg-reopen-1', target: registered.id, turn: 'session', text: 'Please apply the patch' }, now)
    assert.equal(sent.line, 'reopen')

    const polled = messaging.act('poll', { connection: registered.id, secret: registered.secret, turn: 'session' }, now)
    assert.equal(polled.messages.length, 1)
    const claimed = polled.messages[0]

    const outcome = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      {
        message: claimed,
        isLan: false,
        state: 'idle',
        routes: RECORDED_REOPEN_ROUTES,
        recordReceipt: receipt => {
          messaging.act('receipt', {
            connection: registered.id,
            secret: registered.secret,
            id: receipt.id,
            nonce: receipt.nonce,
            status: receipt.status,
            ...(receipt.receiptReply ? { reply: receipt.receiptReply } : {}),
            ...(receipt.error ? { error: receipt.error } : {}),
          }, Date.now())
        },
        s: EN,
      },
    )

    assert.equal(outcome.ok, true)
    assert.equal(outcome.status, 'acknowledged')
    assert.equal(outcome.ack, `ACK ${claimed.nonce}`)
    assert.equal(outcome.reply, 'Updated config.json in workspace.')
    assert.equal(outcome.receiptReply, `ACK ${claimed.nonce} Updated config.json in workspace.`)

    const inv = JSON.parse(readFileSync(recordedCall, 'utf8'))
    assert.equal(inv.args[0], '--resume')
    assert.equal(inv.args[1], 'conv-1234')
    assert.ok(inv.args[2].includes(`ACK ${claimed.nonce}`))
    assert.ok(inv.args[2].includes('Please apply the patch'))
    assert.equal(inv.cwd.toLowerCase(), dir.toLowerCase())

    const stored = messaging.snapshot(Date.now()).messages.find(m => m.id === 'msg-reopen-1')
    assert.equal(stored.status, 'acknowledged')
    assert.equal(stored.reply, 'Updated config.json in workspace.')

    // Missing ACK line -> recorded uncertain, never acknowledged.
    const noAck = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'msg-reopen-2', text: 'MISSING_ACK', nonce: 'f00ba9' }, state: 'idle', routes: RECORDED_REOPEN_ROUTES, s: EN },
    )
    assert.equal(noAck.ok, false)
    assert.equal(noAck.started, true)
    assert.equal(noAck.status, 'uncertain')
    assert.equal(noAck.error, 'ACK_REQUIRED')

    // Timeout -> killed and recorded uncertain.
    const timedOut = await runBackgroundResume(
      { agent: 'cursor', command: 'cursor-agent', resumeFlag: '--resume', conversation: 'conv-1234', cwd: dir, surface: SURFACE_IDS.cli },
      { message: { id: 'msg-reopen-3', text: 'SLOW_TURN', nonce: 'dead99' }, state: 'idle', routes: RECORDED_REOPEN_ROUTES, maxWaitMs: 200, killWaitMs: 1000, s: EN },
    )
    assert.equal(timedOut.ok, false)
    assert.equal(timedOut.started, true)
    assert.equal(timedOut.status, 'uncertain')
    assert.equal(timedOut.error, 'EXIT_TIMEOUT')
  } finally {
    messaging?.close()
    if (previous === undefined) delete process.env.AGENT_BOARD_CURSOR
    else process.env.AGENT_BOARD_CURSOR = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
})

test('card wording explains turn runs/ran in background and to open the AI window in EN, ZH_TW, and ZH_CN', async () => {
  for (const s of [EN, ZH_TW, ZH_CN]) {
    const lineText = routeText('reopen', true, 'cursor', s)
    assert.equal(lineText, s.serveLineReopen('Cursor'))
    const now = Date.now()
    const file = `## Demo\n<!-- auto session=abcdef01 agent=cursor resume=conv-1234 state=waiting updated=${new Date(now).toISOString()} -->\n### Background wording\n- [?] Continue?\n<!-- /auto session=abcdef01 -->\n`
    const view = buildView(parseProgress(file), [], null, now, 0, {}, s)
    const connections = [{ id: 'conn-cursor', agent: 'cursor', session: 'conv-1234', surface: SURFACE_IDS.cli, turn: 'session', scope: 'session', expires: now + 60_000 }]
    const group = { now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] }

    // Before sending: card route line explains background turn and opening the AI window.
    const preModel = serveModel(view, [], s, new Set(), false, { connections, mailboxes: [], messages: [] }, false, group, RECORDED_REOPEN_ROUTES)
    const preDom = await pageDom(servePage(s, 'synthetic-nonce'), preModel, async () => ({ ok: true, json: async () => ({ ok: true }) }))
    assert.ok(preDom.text().includes(s.serveLineReopen('Cursor')))

    // Running receipt: card explains the turn is running in the background and to open the AI window.
    const runningMessages = [{ id: 'm-1', target: 'conn-cursor', turn: 'session', from: 'board', to: 'cursor:conv-1234', text: 'Continue', hash: '0'.repeat(64), origin: 'local', status: 'accepted', updated: now, reply: '', error: '', hops: 0, claimed: now - 10, line: 'reopen' }]
    const runningModel = serveModel(view, [], s, new Set(), false, { connections, mailboxes: [], messages: runningMessages }, false, group, RECORDED_REOPEN_ROUTES)
    const runningDom = await pageDom(servePage(s, 'synthetic-nonce'), runningModel, async () => ({ ok: true, json: async () => ({ ok: true }) }))
    assert.ok(runningDom.text().includes(s.serveReopenRunning('Cursor')))

    // Finished receipt: card explains the turn ran in the background, shows the reply, and tells to open the AI window.
    const doneMessages = [{ id: 'm-1', target: 'conn-cursor', turn: 'session', from: 'board', to: 'cursor:conv-1234', text: '', hash: '0'.repeat(64), origin: 'local', status: 'acknowledged', updated: now, reply: 'Done in background.', error: '', hops: 0, claimed: now - 10, line: 'reopen' }]
    const doneModel = serveModel(view, [], s, new Set(), false, { connections, mailboxes: [], messages: doneMessages }, false, group, RECORDED_REOPEN_ROUTES)
    const doneDom = await pageDom(servePage(s, 'synthetic-nonce'), doneModel, async () => ({ ok: true, json: async () => ({ ok: true }) }))
    assert.ok(doneDom.text().includes(s.serveReopenDone('Cursor')))
    assert.ok(doneDom.text().includes('Done in background.'))
  }
})

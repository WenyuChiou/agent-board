import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
const { enrollMailbox, enrollMcp, mailboxId } = await import('../hooks/hook-messages.ts')
const { address, claimMessages, deliveryText, queueMessage, textHash } = await import('../hooks/messaging.ts')
const { parseMessageStore } = await import('../hooks/queued-store.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { agentLabel } = await import('../hooks/strings.ts')
const { folderIdentity } = await import('../scripts/folder-identity.ts')
const { processStart } = await import('../scripts/board-mcp.ts')
const { defaultMessagesDirectory, writePrivateRuntimeFile } = await import('../scripts/runtime-folder.ts')

const MACHINE_ENV_KEYS = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'OS']

const testWorkspaceDigest = dir => {
  const id = folderIdentity(dir)
  return id?.folderCanonicalDigest ?? id?.folderDigest
}

const cleanEnv = (root, extra = {}) => {
  const run = join(root, 'run')
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  mkdirSync(join(home, '.cache'), { recursive: true })
  mkdirSync(run, { recursive: true, mode: 0o700 })
  mkdirSync(tmp, { recursive: true })
  if (process.platform === 'win32') mkdirSync(join(run, 'agent-board'), { recursive: true })
  const base = Object.fromEntries(MACHINE_ENV_KEYS.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: run,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    CLAUDE_PROGRESS_FILE: '',
    AGENT_BOARD_TEST_PID: String(process.pid),
    NO_COLOR: '1',
    CI: '',
    ...extra,
  }
}

const block = (id, agent, state, project, title, dir, updatedMs = Date.now()) =>
  `## ${project}\n<!-- auto session=${id} agent=${agent} dir=${dir} state=${state} updated=${new Date(updatedMs).toISOString()} -->\n### ${title}\n- [~] Active step\n<!-- /auto session=${id} -->\n`

const writeStore = (messagesDir, state) => {
  mkdirSync(messagesDir, { recursive: true })
  writeFileSync(join(messagesDir, 'messages.json'), JSON.stringify({ version: 2, ...state }))
}

const readStore = (messagesDir, now = Date.now()) => parseMessageStore(readFileSync(join(messagesDir, 'messages.json'), 'utf8'), now)

const makeMailbox = (state, agent, session, dir, now) => {
  const next = enrollMailbox(state, agent, session, 'CLI', now, 600_000)
  const digest = testWorkspaceDigest(dir)
  return {
    ...next,
    mailboxes: (next.mailboxes ?? []).map(box => box.id === mailboxId(agent, session) && digest
      ? { ...box, folderDigest: digest }
      : box),
  }
}

const makeMcpMailbox = (state, agent, session, owner, dir, now) =>
  enrollMcp(state, agent, session, 'mcp', owner, testWorkspaceDigest(dir), now + 600_000, now, 600_000)

const mcpEnvFor = (agent, session, started) => ({
  AGENT_BOARD_AGENT: agent,
  AGENT_BOARD_SESSION_ID: session,
  AGENT_BOARD_HOST_PID: String(process.pid),
  AGENT_BOARD_HOST_STARTED: started,
})

const runCli = (root, args, extraEnv = {}, cwd = undefined) =>
  new Promise((resolve, reject) => {
    const script = join(root, 'agent-board.mjs')
    if (!existsSync(script)) writeFileSync(script, BOARD_SCRIPT)
    execFile(process.execPath, [script, ...args], {
      env: cleanEnv(root, extraEnv),
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ status: error ? error.code : 0, stdout, stderr })
    })
  })

const removeDir = async dir => {
  const deadline = Date.now() + 8_000
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}

test('--send refuses an ambiguous target and lists ranked candidates without session ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-ambig-'))
  try {
    const now = Date.now()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    const winSecretPath = 'C:\\secret\\repo\\auth.ts'
    const unixSecretPath = '/Users/alice/secret/app.ts'
    writeFileSync(progress, [
      '# Progress',
      block('sess-alpha-111', 'codex', 'working', 'Alpha', `Review ${winSecretPath}`, workspace, now),
      block('sess-beta-222', 'claude', 'working', 'Build', 'Release helper', workspace, now),
      block('sess-gamma-333', 'gemini', 'waiting', 'Gamma', `Check ${unixSecretPath}`, workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-alpha-111', workspace, now)
    store = makeMailbox(store, 'claude', 'sess-beta-222', workspace, now)
    store = makeMailbox(store, 'gemini', 'sess-gamma-333', workspace, now)
    writeStore(messagesDir, store)

    const ambig = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'a', 'Check status'], {}, workspace)
    assert.equal(ambig.status, 1, `expected ambiguous target refusal:\nstdout=${ambig.stdout}\nstderr=${ambig.stderr}`)
    const combined = `${ambig.stdout}\n${ambig.stderr}`
    assert.ok(combined.includes('Alpha') && combined.includes('Gamma'), `expected candidates listed:\n${combined}`)
    for (const secret of ['sess-alpha-111', 'sess-beta-222', 'sess-gamma-333', workspace, messagesDir, winSecretPath, unixSecretPath]) {
      assert.equal(combined.includes(secret), false, `must not expose ${secret}`)
    }

    // Exact agent/project name "Build" outranks partial matches and sends cleanly.
    const exact = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'Build', 'Check exact match'], {}, workspace)
    assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`)
    const saved = readStore(messagesDir)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].to, 'claude:sess-beta-222')
  } finally {
    await removeDir(root)
  }
})

test('--send labels an authenticated peer session with its agent and task title and marks unauthenticated callers unverified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-auth-'))
  try {
    const now = Date.now()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    const hostStarted = await processStart(process.pid)
    assert.ok(hostStarted, 'expected host processStart timestamp')
    writeFileSync(progress, [
      '# Progress',
      block('sess-sender-444', 'codex', 'working', 'Workspace', 'Implement API endpoint', workspace, now),
      block('sess-target-555', 'claude', 'working', 'Workspace', 'Write integration tests', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMcpMailbox(store, 'codex', 'sess-sender-444', `${process.pid}:${hostStarted}`, workspace, now)
    store = makeMailbox(store, 'claude', 'sess-target-555', workspace, now)
    writeStore(messagesDir, store)

    const senderEnv = mcpEnvFor('codex', 'sess-sender-444', hostStarted)
    const peer = await runCli(root, [
      '--progress-file', progress,
      '--messages-dir', messagesDir,
      '--lang', 'en',
      '--send', 'claude', 'Schema is ready',
    ], senderEnv, workspace)
    assert.equal(peer.status, 0, `${peer.stdout}\n${peer.stderr}`)

    let saved = readStore(messagesDir)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].from, 'codex:sess-sender-444')
    assert.equal(saved.messages[0].text, 'Schema is ready')
    assert.equal(saved.messages[0].senderTitle, 'Implement API endpoint')
    const claimedPeer = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'a1b2c3')
    assert.equal(claimedPeer.messages.length, 1)
    const deliveredPeer = deliveryText(claimedPeer.messages[0], EN)
    const lines = deliveredPeer.split('\n')
    assert.match(lines[0], /Codex, task "Implement API endpoint"/)
    assert.equal(lines[2], EN.cliSendNoReplyLoop)
    const fenceOpen = lines.findIndex(line => line.startsWith('<<<AB-'))
    assert.ok(fenceOpen >= 3, deliveredPeer)
    assert.equal(lines[fenceOpen + 1], 'Schema is ready')

    saved = {
      ...claimedPeer.state,
      messages: claimedPeer.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })),
    }
    writeStore(messagesDir, saved)

    const zhPeer = await runCli(root, [
      '--progress-file', progress,
      '--messages-dir', messagesDir,
      '--lang', 'zh-TW',
      '--send', 'claude', '綱要已就緒',
    ], senderEnv, workspace)
    assert.equal(zhPeer.status, 0, `${zhPeer.stdout}\n${zhPeer.stderr}`)
    saved = readStore(messagesDir)
    const claimedZh = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'c3d4e5')
    assert.equal(claimedZh.messages.length, 1)
    const deliveredZh = deliveryText(claimedZh.messages[0], ZH_TW)
    assert.ok(deliveredZh.split('\n')[0].includes(ZH_TW.cliSendSenderWithTitle(agentLabel('codex', ZH_TW), 'Implement API endpoint')), deliveredZh)
    assert.ok(deliveredZh.split('\n').slice(0, 4).includes(ZH_TW.cliSendNoReplyLoop), deliveredZh)

    saved = {
      ...claimedZh.state,
      messages: claimedZh.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })),
    }
    writeStore(messagesDir, saved)

    // Supplying only CODEX_THREAD_ID without verified host ownership/secret must be treated as unverified.
    const spoofed = await runCli(root, [
      '--progress-file', progress,
      '--messages-dir', messagesDir,
      '--lang', 'en',
      '--send', 'claude', 'Spoofed caller check',
    ], { CODEX_THREAD_ID: 'sess-sender-444' }, workspace)
    assert.equal(spoofed.status, 0, `${spoofed.stdout}\n${spoofed.stderr}`)

    saved = readStore(messagesDir)
    const unverifiedMsg = saved.messages.at(-1)
    assert.equal(unverifiedMsg.from, 'unverified')
    assert.equal(unverifiedMsg.senderTitle, undefined)
    const claimedAnon = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'd4e5f6')
    const deliveredAnon = deliveryText(claimedAnon.messages[0], EN)
    assert.ok(deliveredAnon.split('\n')[0].includes('(unverified)'), deliveredAnon)
    assert.ok(!deliveredAnon.includes('Implement API endpoint'), deliveredAnon)
    assert.ok(deliveredAnon.split('\n').slice(0, 4).includes(EN.cliSendNoReplyLoop), deliveredAnon)
  } finally {
    await removeDir(root)
  }
})

test('--send stops a reply loop at HOP_LIMIT and tells the sender why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-hop-'))
  try {
    const now = Date.now()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    const hostStarted = await processStart(process.pid)
    assert.ok(hostStarted, 'expected host processStart timestamp')
    writeFileSync(progress, [
      '# Progress',
      block('sess-hop-a', 'codex', 'working', 'Workspace', 'Service A', workspace, now),
      block('sess-hop-b', 'claude', 'working', 'Workspace', 'Service B', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMcpMailbox(store, 'codex', 'sess-hop-a', `${process.pid}:${hostStarted}`, workspace, now)
    store = makeMcpMailbox(store, 'claude', 'sess-hop-b', `${process.pid}:${hostStarted}`, workspace, now)
    writeStore(messagesDir, store)

    // Hop 1: A -> B
    const hop1 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Hop 1'], mcpEnvFor('codex', 'sess-hop-a', hostStarted), workspace)
    assert.equal(hop1.status, 0, `${hop1.stdout}\n${hop1.stderr}`)

    let saved = readStore(messagesDir)
    const claimB = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-hop-b'), Date.now(), '111aaa')
    assert.equal(claimB.messages[0].hops, 1)
    writeStore(messagesDir, { ...claimB.state, messages: claimB.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })) })

    // Hop 2: B -> A
    const hop2 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'codex', 'Hop 2'], mcpEnvFor('claude', 'sess-hop-b', hostStarted), workspace)
    assert.equal(hop2.status, 0, `${hop2.stdout}\n${hop2.stderr}`)

    saved = readStore(messagesDir)
    const claimA = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-hop-a'), Date.now(), '222bbb')
    assert.equal(claimA.messages[0].hops, 2)
    writeStore(messagesDir, { ...claimA.state, messages: claimA.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })) })

    // Hop 3 (> HOP_LIMIT = 2): A -> B must refuse with clear reason and enqueue nothing.
    const hop3 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Hop 3'], mcpEnvFor('codex', 'sess-hop-a', hostStarted), workspace)
    assert.equal(hop3.status, 1, `expected HOP_LIMIT refusal:\nstdout=${hop3.stdout}\nstderr=${hop3.stderr}`)
    const out = `${hop3.stdout}\n${hop3.stderr}`
    assert.ok(/hop|limit|loop/i.test(out), `expected localized HOP_LIMIT reason:\n${out}`)
    assert.equal(readStore(messagesDir).messages.length, 2)
  } finally {
    await removeDir(root)
  }
})

test('--send refuses cross-project agent sends unless --cross-project is given', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-cross-'))
  try {
    const now = Date.now()
    const dirOne = join(root, 'repo-one')
    const dirTwo = join(root, 'repo-two')
    mkdirSync(dirOne, { recursive: true })
    mkdirSync(dirTwo, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    writeFileSync(progress, [
      '# Progress',
      block('sess-one-111', 'codex', 'working', 'RepoOne', 'API work', dirOne, now),
      block('sess-two-222', 'claude', 'working', 'RepoTwo', 'Frontend work', dirTwo, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-one-111', dirOne, now)
    store = makeMailbox(store, 'claude', 'sess-two-222', dirTwo, now)
    writeStore(messagesDir, store)

    const refused = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Cross project ping'], {}, dirOne)
    assert.equal(refused.status, 1, `expected cross-project refusal:\n${refused.stdout}\n${refused.stderr}`)
    const out = `${refused.stdout}\n${refused.stderr}`
    assert.ok(/--cross-project|workspace|project|folder/i.test(out), out)
    assert.equal(readStore(messagesDir).messages.length, 0)

    const allowed = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--cross-project', '--send', 'claude', 'Explicit cross project ping'], {}, dirOne)
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`)

    // Sending literal "--json" (directly or after "--") sends the message rather than triggering --json board output.
    let saved = readStore(messagesDir)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].to, 'claude:sess-two-222')
    writeStore(messagesDir, { ...saved, messages: saved.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: 'ACK' })) })

    const sendDashJson = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--cross-project', '--send', 'claude', '--json'], {}, dirOne)
    assert.equal(sendDashJson.status, 0, `${sendDashJson.stdout}\n${sendDashJson.stderr}`)
    assert.equal(sendDashJson.stdout.trim().startsWith('{'), false, sendDashJson.stdout)
    saved = readStore(messagesDir)
    assert.equal(saved.messages.at(-1)?.text, '--json')

    writeStore(messagesDir, { ...saved, messages: saved.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: 'ACK' })) })
    const sendDoubleDashJson = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--cross-project', '--send', 'claude', '--', '--json'], {}, dirOne)
    assert.equal(sendDoubleDashJson.status, 0, `${sendDoubleDashJson.stdout}\n${sendDoubleDashJson.stderr}`)
    assert.equal(sendDoubleDashJson.stdout.trim().startsWith('{'), false, sendDoubleDashJson.stdout)
    assert.equal(readStore(messagesDir).messages.at(-1)?.text, '--json')
  } finally {
    await removeDir(root)
  }
})

test('--message-ack upgrades an open claimed message to acknowledged without --serve running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-ack-'))
  try {
    const now = Date.now()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    writeFileSync(progress, [
      '# Progress',
      block('sess-ack-1', 'codex', 'working', 'Workspace', 'Review patch', workspace, now),
      block('sess-ack-live', 'codex', 'working', 'Workspace', 'Native turn waiting', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-ack-1', workspace, now)
    const box = store.mailboxes[0]
    const queued = queueMessage(store, { id: 'msg-ack-1', target: box.id, turn: box.turn, text: 'Please check patch' }, 'board', box, now)
    const claimed = claimMessages(queued.state, box, now, 'deadbe')
    writeStore(messagesDir, claimed.state)

    const acked = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--message-ack', 'deadbe', 'Done reviewing patch'], {}, workspace)
    assert.equal(acked.status, 0, `${acked.stdout}\n${acked.stderr}`)

    const saved = readStore(messagesDir)
    assert.equal(saved.messages[0].status, 'acknowledged')
    assert.equal(saved.messages[0].reply, 'ACK deadbe Done reviewing patch')

    const unknown = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--message-ack', '000000'], {}, workspace)
    assert.equal(unknown.status, 1)

    // Live-claimed or awaitsStart message cannot be confirmed by an unbound offline caller.
    const liveConn = { id: 'conn-codex-live', agent: 'codex', session: 'sess-ack-live', surface: 'Codex daemon', turn: 'session', expires: now + 60_000 }
    const liveQueued = queueMessage({ messages: [], mailboxes: [] }, { id: 'msg-live-ack', target: liveConn.id, turn: liveConn.turn, text: 'Wait for turn' }, 'board', liveConn, now)
    const liveClaimed = claimMessages(liveQueued.state, liveConn, now, 'beeff0', undefined, true)
    writeStore(messagesDir, liveClaimed.state)
    const refusedLive = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--message-ack', 'beeff0', 'Premature'], {}, workspace)
    assert.equal(refusedLive.status, 1)
    assert.equal(readStore(messagesDir).messages[0].status, 'uncertain')

    // Expired OpenCode wake with hasAccepted=true still accepts a late CLI --message-ack.
    let lateState = { messages: [], mailboxes: [] }
    lateState = makeMailbox(lateState, 'opencode', 'sess-late-oc', workspace, now - 40 * 60_000)
    const ocBox = lateState.mailboxes[0]
    const ocQueued = queueMessage(lateState, { id: 'msg-late-1', target: ocBox.id, turn: ocBox.turn, text: 'Late ping' }, 'board', ocBox, now - 40 * 60_000)
    const ocClaimed = claimMessages(ocQueued.state, ocBox, now - 40 * 60_000, 'cafeba')
    writeStore(messagesDir, {
      ...ocClaimed.state,
      messages: ocClaimed.state.messages.map(m => ({ ...m, status: 'uncertain', error: 'EXPIRED', hasAccepted: true, updated: now - 5 * 60_000 })),
    })
    const lateAck = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--message-ack', 'cafeba', 'Late reply finished'], {}, workspace)
    assert.equal(lateAck.status, 0, `${lateAck.stdout}\n${lateAck.stderr}`)
    const savedLate = readStore(messagesDir)
    assert.equal(savedLate.messages[0].status, 'acknowledged')
    assert.equal(savedLate.messages[0].reply, 'ACK cafeba Late reply finished')
  } finally {
    await removeDir(root)
  }
})

test('terminal print and --chat show the latest message state without exposing session ids or nonces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-display-'))
  try {
    const now = Date.now() - 2 * 60_000
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const progress = join(root, 'progress.md')
    const messagesDir = join(root, 'messages')
    writeFileSync(progress, [
      '# Progress',
      block('SECRET_SESS_SENDER_606', 'gemini', 'working', 'ProjFrom', 'Sender Task', workspace, now),
      block('SECRET_SESS_Q_101', 'codex', 'working', 'ProjQ', 'Queued Task', workspace, now),
      block('SECRET_SESS_ACC_202', 'claude', 'working', 'ProjAcc', 'Accepted Task', workspace, now),
      block('SECRET_SESS_ACK_303', 'gemini', 'working', 'ProjAck', 'Acknowledged Task', workspace, now),
      block('SECRET_SESS_UNC_404', 'codex', 'working', 'ProjUnc', 'Uncertain Task', workspace, now),
      block('SECRET_SESS_REJ_505', 'claude', 'working', 'ProjRej', 'Rejected Task', workspace, now),
    ].join('\n'))

    const msg = (id, agent, session, status, nonce, extra = {}) => ({
      id,
      target: mailboxId(agent, session),
      turn: 'session',
      from: 'board',
      to: address(agent, session),
      text: status === 'acknowledged' || status === 'rejected' ? '' : `Body ${id}`,
      hash: textHash(`Body ${id}`),
      origin: 'local',
      status,
      updated: now,
      reply: status === 'acknowledged' ? `ACK ${nonce} All set` : '',
      error: status === 'rejected' ? 'DISCONNECTED' : '',
      hops: 1,
      claimed: status === 'queued' ? 0 : now,
      nonce,
      ...extra,
    })

    writeStore(messagesDir, {
      messages: [
        msg('m1', 'codex', 'SECRET_SESS_Q_101', 'queued', '', { from: 'gemini:SECRET_SESS_SENDER_606', updated: now - 10_000 }),
        msg('m2', 'claude', 'SECRET_SESS_ACC_202', 'accepted', 'aa11bb'),
        msg('m3', 'gemini', 'SECRET_SESS_ACK_303', 'acknowledged', 'cc22dd'),
        msg('m4', 'codex', 'SECRET_SESS_UNC_404', 'uncertain', 'ee33ff'),
        msg('m5', 'claude', 'SECRET_SESS_REJ_505', 'rejected', '1122aa'),
      ],
      mailboxes: [],
    })

    const printed = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--print'], {}, workspace)
    assert.equal(printed.status, 0, `${printed.stdout}\n${printed.stderr}`)
    const chatted = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--chat'], {}, workspace)
    assert.equal(chatted.status, 0, `${chatted.stdout}\n${chatted.stderr}`)

    for (const output of [printed.stdout, chatted.stdout]) {
      for (const expectedState of [EN.messagesQueued, EN.messagesAccepted, EN.messagesAcknowledged, EN.messagesUncertain, EN.messagesRejected]) {
        assert.ok(output.includes(expectedState), `missing state "${expectedState}" in:\n${output}`)
      }
      // Sender row (ProjFrom) also renders its outbound exchange status (Queued).
      const senderMatch = output.match(/ProjFrom[\s\S]{0,160}/)
      assert.ok(senderMatch && senderMatch[0].includes(EN.messagesQueued), `expected sender exchange status beside ProjFrom:\n${output}`)
      for (const secret of ['SECRET_SESS_SENDER_606', 'SECRET_SESS_Q_101', 'SECRET_SESS_ACC_202', 'SECRET_SESS_ACK_303', 'SECRET_SESS_UNC_404', 'SECRET_SESS_REJ_505', 'aa11bb', 'cc22dd', 'ee33ff', '1122aa', workspace, messagesDir]) {
        assert.equal(output.includes(secret), false, `must not expose ${secret} in:\n${output}`)
      }
    }
  } finally {
    await removeDir(root)
  }
})

test('--send resolves and delivers to a live receiver connection through a running board server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-live-'))
  const workspace = join(root, 'workspace')
  const otherWorkspace = join(root, 'other-workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(otherWorkspace, { recursive: true })
  const progress = join(root, 'progress.md')
  const env = cleanEnv(root)
  const messagesDir = defaultMessagesDirectory(progress, env.HOME, env, process.platform)
  const now = Date.now()
  writeFileSync(progress, [
    '# Progress',
    block('sess-live-777', 'claude', 'working', 'LiveProj', 'Handle incoming task', workspace, now),
    block('sess-live-sender', 'codex', 'working', 'LiveProj', 'Live receiver sender', workspace, now),
    block('sess-ordinary-codex', 'codex', 'working', 'LiveProj', 'Ordinary hook sender', workspace, now),
  ].join('\n'))
  writeStore(messagesDir, enrollMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-ordinary-codex', 'CLI', now, 600_000))

  let owner = null
  const lostSockets = new Set()
  const lostServer = createHttpServer((req, res) => {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messagesDirectory: messagesDir }))
      return
    }
    if (req.url === '/api/messages/targets') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        connections: [{ id: 'conn-fake-target', agent: 'claude', session: 'sess-live-777', surface: 'Claude Code', turn: 'session', scope: 'session', expires: Date.now() + 60_000 }],
        mailboxes: [],
      }))
      return
    }
    if (req.url === '/api/messages/peer-send') {
      lostSockets.add(req.socket)
      req.socket.destroy()
      return
    }
    res.writeHead(404)
    res.end('{}')
  })

  try {
    const served = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--serve', '--no-open', '--no-codex-send'], {}, workspace)
    assert.equal(served.status, 0, `${served.stdout}\n${served.stderr}`)
    owner = JSON.parse(readFileSync(join(messagesDir, 'server.owner'), 'utf8'))
    const origin = new URL(owner.url).origin
    const token = new URL(owner.url).searchParams.get('t')

    const regSenderRes = await fetch(`${origin}/api/messages/register`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'codex', session: 'sess-live-sender', surface: 'Codex daemon', turn: 'session', scope: 'session' }),
    })
    assert.equal(regSenderRes.status, 200)
    const regSender = await regSenderRes.json()

    const regTargetRes = await fetch(`${origin}/api/messages/register`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', session: 'sess-live-777', surface: 'Claude Code', turn: 'session', scope: 'session' }),
    })
    assert.equal(regTargetRes.status, 200)
    const regTarget = await regTargetRes.json()
    const heartbeat = async conn => {
      const res = await fetch(`${origin}/api/messages/poll`, {
        method: 'POST',
        headers: { 'x-board-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ connection: conn.id, secret: conn.secret, turn: 'session', receive: false }),
      })
      assert.equal(res.status, 200)
    }

    // Receiver-authenticated --send verifies connection + secret at the hub and places senderTitle on line 1 outside data fence.
    const sent = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'claude', 'Live hello'], {
      AGENT_BOARD_CONNECTION_ID: regSender.id,
      AGENT_BOARD_CONNECTION_SECRET: regSender.secret,
      AGENT_BOARD_AGENT: 'codex',
      AGENT_BOARD_SESSION_ID: 'sess-live-sender',
    }, workspace)
    assert.equal(sent.status, 0, `${sent.stdout}\n${sent.stderr}`)

    const pollRes = await fetch(`${origin}/api/messages/poll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ connection: regTarget.id, secret: regTarget.secret, turn: 'session', receive: true }),
    })
    assert.equal(pollRes.status, 200)
    const polled = await pollRes.json()
    assert.equal(polled.messages.length, 1)
    assert.equal(polled.messages[0].from, 'codex:sess-live-sender')
    assert.equal(polled.messages[0].text, 'Live hello')
    const delivered = deliveryText(polled.messages[0], EN)
    assert.match(delivered.split('\n')[0], /Codex, task "Live receiver sender"/)
    assert.equal(delivered.split('\n')[2], EN.cliSendNoReplyLoop)

    // Unbound caller cannot confirm a live receiver message; credentialed live receiver confirms via /api/messages/receipt.
    const nonce = polled.messages[0].nonce
    assert.match(nonce, /^[0-9a-f]{6}$/)
    const unboundAck = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--message-ack', nonce, 'Unauthorized'], {}, workspace)
    assert.equal(unboundAck.status, 1)
    assert.equal(readStore(messagesDir).messages.find(m => m.id === polled.messages[0].id)?.status, 'uncertain')

    await heartbeat(regTarget)
    const liveAck = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--message-ack', nonce, 'Live reply confirmed'], {
      AGENT_BOARD_CONNECTION_ID: regTarget.id,
      AGENT_BOARD_CONNECTION_SECRET: regTarget.secret,
      AGENT_BOARD_AGENT: 'claude',
      AGENT_BOARD_SESSION_ID: 'sess-live-777',
    }, workspace)
    assert.equal(liveAck.status, 0, `${liveAck.stdout}\n${liveAck.stderr}`)
    const savedAck = readStore(messagesDir).messages.find(m => m.id === polled.messages[0].id)
    assert.equal(savedAck?.status, 'acknowledged')
    assert.equal(savedAck?.reply, `ACK ${nonce} Live reply confirmed`)

    // Idempotent retry with --id creates only one message even if called twice.
    const senderRetryEnv = {
      AGENT_BOARD_CONNECTION_ID: regSender.id,
      AGENT_BOARD_CONNECTION_SECRET: regSender.secret,
      AGENT_BOARD_AGENT: 'codex',
      AGENT_BOARD_SESSION_ID: 'sess-live-sender',
    }
    await heartbeat(regSender)
    await heartbeat(regTarget)
    const firstRetry = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--id', 'stable-retry-001', '--send', 'claude', 'Idempotent msg'], senderRetryEnv, workspace)
    assert.equal(firstRetry.status, 0, `${firstRetry.stdout}\n${firstRetry.stderr}`)
    await heartbeat(regSender)
    await heartbeat(regTarget)
    const secondRetry = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--id', 'stable-retry-001', '--send', 'claude', 'Idempotent msg'], senderRetryEnv, workspace)
    assert.equal(secondRetry.status, 0, `${secondRetry.stdout}\n${secondRetry.stderr}`)
    assert.equal(readStore(messagesDir).messages.filter(m => m.id === 'stable-retry-001').length, 1)

    // Cross-project send to live connection is refused unless --cross-project is passed.
    await heartbeat(regTarget)
    const blocked = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'claude', 'Cross blocked'], {}, otherWorkspace)
    assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`)

    await heartbeat(regTarget)
    const allowed = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--cross-project', '--send', 'claude', 'Cross allowed'], {}, otherWorkspace)
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`)

    // Same-workspace send TO an ordinary enrollMailbox session (no folderDigest stored on mailbox) also succeeds.
    const toOrdinary = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'Ordinary hook sender', 'Ping ordinary mailbox'], {}, workspace)
    assert.equal(toOrdinary.status, 0, `${toOrdinary.stdout}\n${toOrdinary.stderr}`)

    // Stop the real server, then verify uncertain transport error tells caller to retry with --id instead of "Not sent".
    const runDir = process.platform === 'win32' ? join(root, 'run', 'agent-board') : join(root, 'run')
    const addrFiles = readdirSync(runDir).filter(f => f.startsWith('agent-board-') && f.endsWith('.json'))
    assert.ok(addrFiles.length > 0, `expected runtime address file in ${runDir}`)
    const stopped = await runCli(root, ['--progress-file', progress, '--stop'], {}, workspace)
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`)
    if (owner?.pid) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try { process.kill(owner.pid, 0); await new Promise(r => setTimeout(r, 100)) } catch { break }
      }
      try { process.kill(owner.pid, 0); process.kill(owner.pid) } catch {}
    }
    await new Promise(done => lostServer.listen(0, '127.0.0.1', done))
    const lostPort = lostServer.address().port
    const lostRootUrl = `http://127.0.0.1:${lostPort}/?t=synthetic-lost-token`
    writeFileSync(join(messagesDir, 'server.lock'), String(process.pid))
    writeFileSync(join(messagesDir, 'server.owner'), JSON.stringify({ pid: process.pid, port: lostPort, url: lostRootUrl }))
    for (const f of addrFiles) {
      const addrPath = join(runDir, f)
      rmSync(addrPath, { force: true })
      const addrJson = JSON.stringify({ pid: process.pid, port: lostPort, url: lostRootUrl, path: progress, built: '' })
      if (process.platform === 'win32') writePrivateRuntimeFile(addrPath, addrJson)
      else writeFileSync(addrPath, addrJson, { mode: 0o600 })
    }
    const lost = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--id', 'lost-resp-001', '--send', 'claude', 'Lost response ping'], {}, workspace)
    assert.equal(lost.status, 1, `${lost.stdout}\n${lost.stderr}`)
    assert.ok(lost.stderr.includes('--id lost-resp-001'), lost.stderr)
    assert.equal(lost.stderr.includes('Not sent'), false, lost.stderr)
  } finally {
    for (const sock of lostSockets) sock.destroy()
    if (lostServer.listening) await new Promise(done => lostServer.close(done))
    rmSync(join(messagesDir, 'server.lock'), { force: true })
    rmSync(join(messagesDir, 'server.owner'), { force: true })
    const cleanRunDir = process.platform === 'win32' ? join(root, 'run', 'agent-board') : join(root, 'run')
    try {
      for (const f of readdirSync(cleanRunDir)) {
        if (f.startsWith('agent-board-') && f.endsWith('.json')) rmSync(join(cleanRunDir, f), { force: true })
      }
    } catch {}
    await runCli(root, ['--progress-file', progress, '--stop'], {}, workspace).catch(() => {})
    if (owner?.pid) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { process.kill(owner.pid, 0); await new Promise(r => setTimeout(r, 100)) } catch { break }
      }
      try { process.kill(owner.pid, 0); process.kill(owner.pid) } catch {}
    }
    await removeDir(root)
  }
})

test('--send matches same-workspace MCP mailbox alongside a live connection and across symlinked paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-symlink-'))
  const realWorkspace = join(root, 'real-workspace')
  const aliasWorkspace = join(root, 'alias-workspace')
  const otherWorkspace = join(root, 'other-workspace')
  const aliasMessagesDir = join(root, 'alias-messages')
  const realMessagesDir = join(root, 'real-messages')
  mkdirSync(realWorkspace, { recursive: true })
  mkdirSync(otherWorkspace, { recursive: true })
  mkdirSync(realMessagesDir, { recursive: true })
  symlinkSync(realWorkspace, aliasWorkspace, process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(realMessagesDir, aliasMessagesDir, process.platform === 'win32' ? 'junction' : 'dir')
  const progress = join(root, 'progress.md')
  const env = cleanEnv(root)
  const messagesDir = defaultMessagesDirectory(progress, env.HOME, env, process.platform)
  const now = Date.now()
  writeFileSync(progress, [
    '# Progress',
    block('sess-symlink-codex', 'codex', 'working', 'LinkProj', 'Symlink sender', aliasWorkspace, now),
  ].join('\n'))
  writeStore(messagesDir, enrollMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-symlink-codex', 'CLI', now, 600_000))
  writeStore(realMessagesDir, makeMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-symlink-codex', realWorkspace, now))

  let owner = null
  try {
    // Offline send against a symlinked messages directory must be refused cleanly.
    const unsafeDirRes = await runCli(root, ['--progress-file', progress, '--messages-dir', aliasMessagesDir, '--lang', 'en', '--send', 'codex', 'Unsafe dir'], {}, realWorkspace)
    assert.equal(unsafeDirRes.status, 1, `${unsafeDirRes.stdout}\n${unsafeDirRes.stderr}`)
    assert.ok(unsafeDirRes.stderr.includes('UNSAFE_MESSAGE_DIRECTORY'), unsafeDirRes.stderr)

    // Offline default-messages-dir send runs privateFolder ACL check cleanly without failing ACL setup.
    const defaultOffline = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'codex', 'Default ACL check'], {}, realWorkspace)
    assert.equal(defaultOffline.status, 0, `${defaultOffline.stdout}\n${defaultOffline.stderr}`)
    assert.equal(defaultOffline.stderr.includes('MESSAGE_STORE_ACL'), false, defaultOffline.stderr)
    writeStore(messagesDir, enrollMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-symlink-codex', 'CLI', now, 600_000))

    const served = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--serve', '--no-open', '--no-codex-send'], {}, realWorkspace)
    assert.equal(served.status, 0, `${served.stdout}\n${served.stderr}`)
    owner = JSON.parse(readFileSync(join(messagesDir, 'server.owner'), 'utf8'))
    const origin = new URL(owner.url).origin
    const token = new URL(owner.url).searchParams.get('t')

    const hostStarted = await processStart(process.pid)
    assert.ok(hostStarted, 'expected host processStart timestamp')

    const mcpRes = await fetch(`${origin}/api/messages/mcp-enroll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'gemini',
        session: 'sess-dual-888',
        surface: 'mcp',
        owner: `${process.pid}:${hostStarted}`,
        folderDigest: testWorkspaceDigest(realWorkspace),
        until: Date.now() + 600_000,
      }),
    })
    assert.equal(mcpRes.status, 200)

    const regRes = await fetch(`${origin}/api/messages/register`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'gemini', session: 'sess-dual-888', surface: 'Gemini CLI', turn: 'session', scope: 'session' }),
    })
    assert.equal(regRes.status, 200)
    const reg = await regRes.json()

    // Dual live + MCP mailbox session (no progress.md entry) accepts same-workspace send from symlinked cwd.
    const sentDual = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'gemini', 'Dual live and MCP'], {}, aliasWorkspace)
    assert.equal(sentDual.status, 0, `${sentDual.stdout}\n${sentDual.stderr}`)

    const pollRes = await fetch(`${origin}/api/messages/poll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ connection: reg.id, secret: reg.secret, turn: 'session', receive: true }),
    })
    assert.equal(pollRes.status, 200)
    const polled = await pollRes.json()
    assert.equal(polled.messages.length, 1)
    assert.equal(polled.messages[0].from, 'unverified')
    assert.ok(polled.messages[0].text.includes('Dual live and MCP'))

    // Real workspace cwd matches codex progress dir (aliasWorkspace) via canonical digest.
    const sentSymlink = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'codex', 'Real to symlink'], {}, realWorkspace)
    assert.equal(sentSymlink.status, 0, `${sentSymlink.stdout}\n${sentSymlink.stderr}`)

    const wrongWorkspace = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'gemini', 'Wrong workspace'], {}, otherWorkspace)
    assert.equal(wrongWorkspace.status, 1, `${wrongWorkspace.stdout}\n${wrongWorkspace.stderr}`)
  } finally {
    await runCli(root, ['--progress-file', progress, '--stop'], {}, realWorkspace).catch(() => {})
    if (owner?.pid) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { process.kill(owner.pid, 0); await new Promise(r => setTimeout(r, 100)) } catch { break }
      }
      try { process.kill(owner.pid, 0); process.kill(owner.pid) } catch {}
    }
    await removeDir(root)
  }
})

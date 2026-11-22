import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const { enrollMailbox, mailboxId } = await import('../hooks/hook-messages.ts')
const { address, claimMessages, deliveryText, queueMessage, textHash } = await import('../hooks/messaging.ts')
const { parseMessageStore, queuedMessagingOf } = await import('../hooks/queued-store.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { agentLabel } = await import('../hooks/strings.ts')
const { workspaceDigest } = await import('../scripts/folder-identity.ts')
const { defaultMessagesDirectory } = await import('../scripts/runtime-folder.ts')

const MACHINE_ENV_KEYS = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'OS']

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
    AGENT_BOARD_TEST_PID: '',
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
  const digest = workspaceDigest(dir)
  return {
    ...next,
    mailboxes: (next.mailboxes ?? []).map(box => box.id === mailboxId(agent, session) && digest
      ? { ...box, folderDigest: digest }
      : box),
  }
}

const runCli = (root, args, extraEnv = {}, cwd = undefined) =>
  new Promise((resolve, reject) => {
    const script = join(root, 'agent-board.mjs')
    if (!existsSync(script)) writeFileSync(script, BOARD_SCRIPT)
    execFile(process.execPath, [script, ...args], {
      env: cleanEnv(root, extraEnv),
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
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
    writeFileSync(progress, [
      '# Progress',
      block('sess-alpha-111', 'codex', 'working', 'Alpha', 'Review build logs', workspace, now),
      block('sess-beta-222', 'claude', 'working', 'Build', 'Release helper', workspace, now),
      block('sess-gamma-333', 'gemini', 'waiting', 'Gamma', 'Fix build step', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-alpha-111', workspace, now)
    store = makeMailbox(store, 'claude', 'sess-beta-222', workspace, now)
    store = makeMailbox(store, 'gemini', 'sess-gamma-333', workspace, now)
    writeStore(messagesDir, store)

    // "build" matches Beta by exact project name (rank above title-only partial matches) ONLY if unique;
    // "build" matches partial titles across Alpha & Gamma AND wait: test tied rank with "helper" or two identical words!
    // Use "step" / shared partial token in multiple titles for exact tie at top rank, plus exact project override!
    const ambig = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'a', 'Check status'], {}, workspace)
    assert.equal(ambig.status, 1, `expected ambiguous target refusal:\nstdout=${ambig.stdout}\nstderr=${ambig.stderr}`)
    const combined = `${ambig.stdout}\n${ambig.stderr}`
    assert.ok(combined.includes('Alpha') && combined.includes('Gamma'), `expected candidates listed:\n${combined}`)
    for (const secret of ['sess-alpha-111', 'sess-beta-222', 'sess-gamma-333', workspace, messagesDir]) {
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
    writeFileSync(progress, [
      '# Progress',
      block('sess-sender-444', 'codex', 'working', 'Workspace', 'Implement API endpoint', workspace, now),
      block('sess-target-555', 'claude', 'working', 'Workspace', 'Write integration tests', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-sender-444', workspace, now)
    store = makeMailbox(store, 'claude', 'sess-target-555', workspace, now)
    writeStore(messagesDir, store)

    const peer = await runCli(root, [
      '--progress-file', progress,
      '--messages-dir', messagesDir,
      '--lang', 'en',
      '--send', 'claude', 'Schema is ready',
    ], { CODEX_THREAD_ID: 'sess-sender-444' }, workspace)
    assert.equal(peer.status, 0, `${peer.stdout}\n${peer.stderr}`)

    let saved = readStore(messagesDir)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].from, 'codex:sess-sender-444')
    const claimedPeer = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'a1b2c3')
    assert.equal(claimedPeer.messages.length, 1)
    const deliveredPeer = deliveryText(claimedPeer.messages[0], EN)
    assert.ok(deliveredPeer.includes('Message from Codex (task "Implement API endpoint"), not from you'), deliveredPeer)
    assert.ok(/not message back unless the person asked/i.test(deliveredPeer), deliveredPeer)

    // Settle first message so PAIR_OPEN_CAP allows localized and unauthenticated send checks.
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
    ], { CODEX_THREAD_ID: 'sess-sender-444' }, workspace)
    assert.equal(zhPeer.status, 0, `${zhPeer.stdout}\n${zhPeer.stderr}`)
    saved = readStore(messagesDir)
    const claimedZh = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'c3d4e5')
    assert.equal(claimedZh.messages.length, 1)
    const deliveredZh = deliveryText(claimedZh.messages[0], ZH_TW)
    assert.ok(deliveredZh.includes(ZH_TW.cliSendDeliveryFrom(agentLabel('codex', ZH_TW), 'Implement API endpoint')), deliveredZh)

    saved = {
      ...claimedZh.state,
      messages: claimedZh.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })),
    }
    writeStore(messagesDir, saved)

    const anon = await runCli(root, [
      '--progress-file', progress,
      '--messages-dir', messagesDir,
      '--lang', 'en',
      '--send', 'claude', 'Unverified check',
    ], {}, workspace)
    assert.equal(anon.status, 0, `${anon.stdout}\n${anon.stderr}`)

    saved = readStore(messagesDir)
    const unverifiedMsg = saved.messages.at(-1)
    assert.equal(unverifiedMsg.from, 'unverified')
    const claimedAnon = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-target-555'), Date.now(), 'd4e5f6')
    const deliveredAnon = deliveryText(claimedAnon.messages[0], EN)
    assert.ok(deliveredAnon.includes('Message from unverified local caller, not from you'), deliveredAnon)
    assert.ok(/not message back unless the person asked/i.test(deliveredAnon), deliveredAnon)
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
    writeFileSync(progress, [
      '# Progress',
      block('sess-hop-a', 'codex', 'working', 'Workspace', 'Service A', workspace, now),
      block('sess-hop-b', 'claude', 'working', 'Workspace', 'Service B', workspace, now),
    ].join('\n'))
    let store = { messages: [], mailboxes: [] }
    store = makeMailbox(store, 'codex', 'sess-hop-a', workspace, now)
    store = makeMailbox(store, 'claude', 'sess-hop-b', workspace, now)
    writeStore(messagesDir, store)

    // Hop 1: A -> B
    const hop1 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Hop 1'], { AGENT_BOARD_SESSION_ID: 'sess-hop-a' }, workspace)
    assert.equal(hop1.status, 0, `${hop1.stdout}\n${hop1.stderr}`)

    let saved = readStore(messagesDir)
    const claimB = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-hop-b'), Date.now(), '111aaa')
    assert.equal(claimB.messages[0].hops, 1)
    writeStore(messagesDir, { ...claimB.state, messages: claimB.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })) })

    // Hop 2: B -> A
    const hop2 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'codex', 'Hop 2'], { AGENT_BOARD_SESSION_ID: 'sess-hop-b' }, workspace)
    assert.equal(hop2.status, 0, `${hop2.stdout}\n${hop2.stderr}`)

    saved = readStore(messagesDir)
    const claimA = claimMessages(saved, saved.mailboxes.find(b => b.session === 'sess-hop-a'), Date.now(), '222bbb')
    assert.equal(claimA.messages[0].hops, 2)
    writeStore(messagesDir, { ...claimA.state, messages: claimA.state.messages.map(m => ({ ...m, status: 'acknowledged', text: '', reply: `ACK ${m.nonce}` })) })

    // Hop 3 (> HOP_LIMIT = 2): A -> B must refuse with clear reason and enqueue nothing.
    const hop3 = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Hop 3'], { AGENT_BOARD_SESSION_ID: 'sess-hop-a' }, workspace)
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

    const refused = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--send', 'claude', 'Cross project ping'], { CODEX_THREAD_ID: 'sess-one-111' }, dirOne)
    assert.equal(refused.status, 1, `expected cross-project refusal:\n${refused.stdout}\n${refused.stderr}`)
    const out = `${refused.stdout}\n${refused.stderr}`
    assert.ok(/--cross-project|workspace|project|folder/i.test(out), out)
    assert.equal(readStore(messagesDir).messages.length, 0)

    const allowed = await runCli(root, ['--progress-file', progress, '--messages-dir', messagesDir, '--lang', 'en', '--cross-project', '--send', 'claude', 'Explicit cross project ping'], { CODEX_THREAD_ID: 'sess-one-111' }, dirOne)
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`)
    const saved = readStore(messagesDir)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].to, 'claude:sess-two-222')
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
        msg('m1', 'codex', 'SECRET_SESS_Q_101', 'queued', ''),
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
      for (const secret of ['SECRET_SESS_Q_101', 'SECRET_SESS_ACC_202', 'SECRET_SESS_ACK_303', 'SECRET_SESS_UNC_404', 'SECRET_SESS_REJ_505', 'aa11bb', 'cc22dd', 'ee33ff', '1122aa', workspace, messagesDir]) {
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
    block('sess-ordinary-codex', 'codex', 'working', 'LiveProj', 'Ordinary hook sender', workspace, now),
  ].join('\n'))
  // Ordinary mailbox enrollment leaves folderDigest unset on the mailbox record; CLI + hub resolve workspace from progress dir.
  writeStore(messagesDir, enrollMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-ordinary-codex', 'CLI', now, 600_000))

  let owner = null
  try {
    const served = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--serve', '--no-open'], {}, workspace)
    assert.equal(served.status, 0, `${served.stdout}\n${served.stderr}`)
    owner = JSON.parse(readFileSync(join(messagesDir, 'server.owner'), 'utf8'))
    const origin = new URL(owner.url).origin
    const token = new URL(owner.url).searchParams.get('t')

    const regRes = await fetch(`${origin}/api/messages/register`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', session: 'sess-live-777', surface: 'Claude Code', turn: 'session', scope: 'session' }),
    })
    assert.equal(regRes.status, 200)
    const reg = await regRes.json()

    // Same-workspace CLI --send reaches live connection (and binds ordinary mailbox sender via progress dir).
    const sent = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'claude', 'Live hello'], { CODEX_THREAD_ID: 'sess-ordinary-codex' }, workspace)
    assert.equal(sent.status, 0, `${sent.stdout}\n${sent.stderr}`)

    const pollRes = await fetch(`${origin}/api/messages/poll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ connection: reg.id, secret: reg.secret, turn: 'session', receive: true }),
    })
    assert.equal(pollRes.status, 200)
    const polled = await pollRes.json()
    assert.equal(polled.messages.length, 1)
    assert.equal(polled.messages[0].from, 'codex:sess-ordinary-codex')
    assert.ok(polled.messages[0].text.includes('Live hello'))
    const delivered = deliveryText(polled.messages[0], EN)
    assert.ok(delivered.includes('Message from Codex (task "Ordinary hook sender"), not from you'), delivered)

    // Live-only recipient can confirm its claimed message via --message-ack while --serve is running.
    const nonce = polled.messages[0].nonce
    assert.match(nonce, /^[0-9a-f]{6}$/)
    const liveAck = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--message-ack', nonce, 'Live reply confirmed'], { CLAUDE_SESSION_ID: 'sess-live-777' }, workspace)
    assert.equal(liveAck.status, 0, `${liveAck.stdout}\n${liveAck.stderr}`)
    const savedAck = readStore(messagesDir).messages.find(m => m.id === polled.messages[0].id)
    assert.equal(savedAck?.status, 'acknowledged')
    assert.equal(savedAck?.reply, `ACK ${nonce} Live reply confirmed`)

    // Cross-project send to live connection is refused unless --cross-project is passed.
    const blocked = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'claude', 'Cross blocked'], {}, otherWorkspace)
    assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`)

    const allowed = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--cross-project', '--send', 'claude', 'Cross allowed'], {}, otherWorkspace)
    assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`)

    // Same-workspace send TO an ordinary enrollMailbox session (no folderDigest stored on mailbox) also succeeds.
    const toOrdinary = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'codex', 'Ping ordinary mailbox'], {}, workspace)
    assert.equal(toOrdinary.status, 0, `${toOrdinary.stdout}\n${toOrdinary.stderr}`)
  } finally {
    await runCli(root, ['--progress-file', progress, '--stop'], {}, workspace).catch(() => {})
    if (owner?.pid) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try { process.kill(owner.pid, 0); await new Promise(r => setTimeout(r, 100)) } catch { break }
      }
    }
    await removeDir(root)
  }
})

test('--send matches same-workspace MCP mailbox alongside a live connection and across symlinked paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-send-symlink-'))
  const realWorkspace = join(root, 'real-workspace')
  const aliasWorkspace = join(root, 'alias-workspace')
  const otherWorkspace = join(root, 'other-workspace')
  mkdirSync(realWorkspace, { recursive: true })
  mkdirSync(otherWorkspace, { recursive: true })
  symlinkSync(realWorkspace, aliasWorkspace, process.platform === 'win32' ? 'junction' : 'dir')
  const progress = join(root, 'progress.md')
  const env = cleanEnv(root)
  const messagesDir = defaultMessagesDirectory(progress, env.HOME, env, process.platform)
  const now = Date.now()
  // Only codex is in progress.md (bound to the symlink path); gemini has no progress entry at all.
  writeFileSync(progress, [
    '# Progress',
    block('sess-symlink-codex', 'codex', 'working', 'LinkProj', 'Symlink sender', aliasWorkspace, now),
  ].join('\n'))
  writeStore(messagesDir, enrollMailbox({ messages: [], mailboxes: [] }, 'codex', 'sess-symlink-codex', 'CLI', now, 600_000))

  let owner = null
  try {
    const served = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--serve', '--no-open'], {}, realWorkspace)
    assert.equal(served.status, 0, `${served.stdout}\n${served.stderr}`)
    owner = JSON.parse(readFileSync(join(messagesDir, 'server.owner'), 'utf8'))
    const origin = new URL(owner.url).origin
    const token = new URL(owner.url).searchParams.get('t')

    const mcpRes = await fetch(`${origin}/api/messages/mcp-enroll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'gemini',
        session: 'sess-dual-888',
        surface: 'MCP',
        owner: `${process.pid}:test-start`,
        folderDigest: workspaceDigest(realWorkspace),
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
    const sentDual = await runCli(root, ['--progress-file', progress, '--lang', 'en', '--send', 'gemini', 'Dual live and MCP'], { CODEX_THREAD_ID: 'sess-symlink-codex' }, aliasWorkspace)
    assert.equal(sentDual.status, 0, `${sentDual.stdout}\n${sentDual.stderr}`)

    const pollRes = await fetch(`${origin}/api/messages/poll`, {
      method: 'POST',
      headers: { 'x-board-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ connection: reg.id, secret: reg.secret, turn: 'session', receive: true }),
    })
    assert.equal(pollRes.status, 200)
    const polled = await pollRes.json()
    assert.equal(polled.messages.length, 1)
    assert.equal(polled.messages[0].from, 'codex:sess-symlink-codex')
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
    }
    await removeDir(root)
  }
})

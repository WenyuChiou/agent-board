import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'

const resolveLocal = (specifier, context, next) => {
  try {
    return next(specifier, context)
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
}
registerHooks({ resolve: resolveLocal })

const { BOARD_SCRIPT } = await import('../hooks/board-script.ts')
const { asData } = await import('../hooks/mirror.ts')
const { EN } = await import('../hooks/strings-en.ts')
const { ZH_CN } = await import('../hooks/strings-zh-cn.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')
const { addressFileName } = await import('../hooks/receiver.ts')
const {
  address,
  claimMessages,
  deliveryText,
  HOP_LIMIT,
  PEER_PAIR_BUDGET,
  queueMessage,
  textHash,
} = await import('../hooks/messaging.ts')
const { enrollMailbox, mailboxId } = await import('../hooks/hook-messages.ts')
const { parseMessageStore } = await import('../hooks/queued-store.ts')
const { createMessaging } = await import('../scripts/board-messaging.ts')
const { folderIdentity } = await import('../scripts/folder-identity.ts')
const { isPrivateDacl, runningAccount } = await import('../scripts/private-folder.ts')
const {
  defaultMessagesDirectory,
  privateRuntimeFolder,
  writePrivateRuntimeFile,
} = await import('../scripts/runtime-folder.ts')

const workspaceDigestOf = dir => {
  const identity = folderIdentity(dir)
  return identity.folderCanonicalDigest ?? identity.folderDigest
}

const recordedRoutes = JSON.parse(readFileSync(new URL('./helpers/recorded-routes.json', import.meta.url), 'utf8'))

const tempRoot = (prefix = 'ab-cli-send-') => mkdtempSync(join(tmpdir(), prefix))

const isoAgo = (now, deltaMs = 60_000) => new Date(now - deltaMs).toISOString()

const autoBlock = ({ agent, session, project, title, dir, updatedIso, state = 'working', step = '- [~] Active check' }) =>
  `## ${project}\n<!-- auto session=${session} agent=${agent} state=${state} updated=${updatedIso}${dir ? ` dir=${dir}` : ''} -->\n### ${title}\n${step}\n<!-- /auto session=${session} -->\n`

let sharedWorkRoot
const getSharedWorkRoot = () => {
  if (!sharedWorkRoot) sharedWorkRoot = tempRoot('ab-cli-shared-')
  return sharedWorkRoot
}

const addressFolderFor = runtimeDir => (
  process.platform === 'win32' ? join(runtimeDir, 'agent-board') : runtimeDir
)

const writeAddressFile = (file, text) => {
  if (process.platform === 'win32') writePrivateRuntimeFile(file, text)
  else writeFileSync(file, text, { mode: 0o600, flag: 'wx' })
}

let sharedRuntimeDir
const getSharedRuntimeDir = () => {
  if (!sharedRuntimeDir) {
    const candidate = join(getSharedWorkRoot(), 'runtime')
    mkdirSync(candidate, { recursive: true, mode: 0o700 })
    const cacheDir = addressFolderFor(candidate)
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') privateRuntimeFolder(cacheDir)
    else {
      chmodSync(candidate, 0o700)
      chmodSync(cacheDir, 0o700)
    }
    sharedRuntimeDir = candidate
  }
  return sharedRuntimeDir
}

let sharedScriptPath
const getSharedBoardScript = () => {
  if (!sharedScriptPath) {
    sharedScriptPath = join(getSharedWorkRoot(), 'agent-board.mjs')
    writeFileSync(sharedScriptPath, BOARD_SCRIPT)
  }
  return sharedScriptPath
}

after(() => {
  if (sharedWorkRoot) {
    rmSync(sharedWorkRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    sharedWorkRoot = undefined
    sharedRuntimeDir = undefined
    sharedScriptPath = undefined
  }
})

const baseChildEnv = (root, extra = {}, omit = []) => {
  const home = extra.HOME ?? join(root, 'home')
  const runtimeDir = extra.XDG_RUNTIME_DIR ?? sharedRuntimeDir ?? join(root, 'runtime')
  const env = {
    ...process.env,
    AGENT_BOARD_TEST_PID: String(process.pid),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    XDG_RUNTIME_DIR: runtimeDir,
    AGENT_BOARD_AGENT: '',
    AGENT_BOARD_SESSION_ID: '',
    AGENT_BOARD_CONNECTION_ID: '',
    AGENT_BOARD_CONNECTION_SECRET: '',
    AGENT_BOARD_HOST_PID: '',
    AGENT_BOARD_HOST_STARTED: '',
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    ...extra,
  }
  for (const key of omit) delete env[key]
  return env
}

const runCli = async (root, cliArgs, { cwd = root, env = {}, omit = [], timeoutMs = 15_000 } = {}) => {
  const scriptPath = getSharedBoardScript()
  const child = spawn(
    process.execPath,
    [scriptPath, ...cliArgs],
    { cwd, env: baseChildEnv(root, env, omit), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  const exited = once(child, 'exit')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch {}
    }
  }, timeoutMs)
  try {
    const [status] = await exited
    return { status: status ?? 1, stdout, stderr }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch {}
    }
    await exited.catch(() => {})
  }
}

const closeServer = server => (server.listening ? new Promise(done => {
  server.close(() => done())
  server.closeAllConnections?.()
}) : Promise.resolve())

const postJson = async (url, token, action, payload) => {
  const base = new URL(url)
  const res = await fetch(`http://127.0.0.1:${base.port}/api/messages/${action}`, {
    method: 'POST',
    headers: { 'x-board-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const startHub = async (root, {
  progressPath = join(root, 'progress.md'),
  messagesDir = join(root, 'messages'),
  runtimeDir = getSharedRuntimeDir(),
  reportsOf = () => [],
  gate = { routes: recordedRoutes, stateOfSession: () => 'working' },
} = {}) => {
  mkdirSync(messagesDir, { recursive: true })
  const cacheDir = addressFolderFor(runtimeDir)
  const store = createMessaging(messagesDir, false, gate)
  const token = 'test-hub-token'
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers['x-board-token'] !== token) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messagesDirectory: messagesDir, pageAgo: null, wantsKeyedPage: false }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname.startsWith('/api/messages/')) {
      const action = reqUrl.pathname.slice('/api/messages/'.length)
      let raw = ''
      for await (const chunk of req) raw += chunk
      try {
        const body = raw === '' ? {} : JSON.parse(raw)
        const result = store.act(action, body, Date.now(), reportsOf())
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'MESSAGE_FAILED' }))
      }
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  try {
    await new Promise((done, fail) => {
      const onError = error => fail(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        done()
      })
    })
    const { port } = server.address()
    const url = `http://127.0.0.1:${port}/?t=${token}`
    const resolvedProgress = resolve(progressPath)
    const addressFile = join(cacheDir, addressFileName(resolvedProgress))
    writeAddressFile(addressFile, JSON.stringify({ pid: process.pid, port, url, path: resolvedProgress, built: '' }))
    store.recordOwner(port, url)
    return {
      store,
      url,
      token,
      port,
      post: (action, payload) => postJson(url, token, action, payload),
      close: async () => {
        await closeServer(server)
        store.close()
      },
    }
  } catch (error) {
    await closeServer(server).catch(() => {})
    try { store.close() } catch {}
    throw error
  }
}

const waitUntil = async (fn, timeoutMs = 12_000, stepMs = 40) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(done => setTimeout(done, stepMs))
  }
  throw lastError ?? new Error('Timed out waiting for condition')
}

const startServeHub = async (root, {
  progressPath = join(root, 'progress.md'),
  messagesDir = join(root, 'messages'),
  runtimeDir = join(root, 'runtime'),
  homeDir = join(root, 'home'),
  lang = 'en',
} = {}) => {
  mkdirSync(messagesDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(runtimeDir, 0o700)
  mkdirSync(homeDir, { recursive: true })
  const scriptPath = getSharedBoardScript()
  const env = baseChildEnv(root, { HOME: homeDir, USERPROFILE: homeDir, XDG_RUNTIME_DIR: runtimeDir })
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      '--serve-child', '--no-codex-send',
      '--lang', lang,
      '--progress-file', progressPath,
      '--messages-dir', messagesDir,
    ],
    { cwd: dirname(root), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  const exited = once(child, 'exit').catch(() => {})
  let stderr = ''
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const addrPath = join(addressFolderFor(runtimeDir), addressFileName(resolve(progressPath)))
  try {
    const info = await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`--serve-child exited early (${child.exitCode ?? child.signalCode}): ${stderr}\n${stdout}`)
      if (!existsSync(addrPath)) return null
      const parsed = JSON.parse(readFileSync(addrPath, 'utf8'))
      const res = await fetch(`http://127.0.0.1:${parsed.port}/api/ping`, {
        headers: { 'x-board-token': new URL(parsed.url).searchParams.get('t') ?? '' },
        signal: AbortSignal.timeout(1000),
      })
      return res.ok ? parsed : null
    }, 15_000, 50)
    const token = new URL(info.url).searchParams.get('t') ?? ''
    return {
      url: info.url,
      token,
      port: info.port,
      post: (action, payload) => postJson(info.url, token, action, payload),
      close: async () => {
        try {
          await fetch(`http://127.0.0.1:${info.port}/api/close`, {
            method: 'POST',
            headers: { 'x-board-token': token, 'content-type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(3000),
          })
        } catch {}
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([exited, new Promise(done => setTimeout(done, 1500))])
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill() } catch {}
          }
          await exited
        }
      },
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch {}
    }
    await exited
    throw error
  }
}

const registerReceiver = async (hub, { agent, session, dir: _dir, scope = 'session', turn = scope === 'session' ? 'session' : 'turn-1', surface = 'CLI' }) => {
  const res = await hub.post('register', { agent, session, scope, turn, surface, origin: 'local' })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  return res.data
}

const pollAndAck = async (hub, reg, reply = 'Done') => {
  const polled = await hub.post('poll', { connection: reg.id, secret: reg.secret, turn: reg.turn })
  assert.equal(polled.status, 200, JSON.stringify(polled.data))
  for (const msg of polled.data.messages) {
    const acked = await hub.post('receipt', {
      connection: reg.id,
      secret: reg.secret,
      id: msg.id,
      nonce: msg.nonce,
      status: 'acknowledged',
      reply: `ACK ${msg.nonce} ${reply}`,
    })
    assert.equal(acked.status, 200, JSON.stringify(acked.data))
  }
  return polled.data.messages
}

const readDaclSddl = targetDir => {
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  const holder = mkdtempSync(join(dirname(resolve(targetDir)), '.acl-check-'))
  const saved = join(holder, 'dacl.txt')
  try {
    execFileSync(icacls, [resolve(targetDir), '/save', saved, '/L'], { encoding: 'utf8', windowsHide: true })
    const lines = readFileSync(saved).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
    assert.equal(lines.length, 2, `Unexpected icacls output: ${lines.join(' | ')}`)
    assert.ok(lines[1].startsWith('D:'), `Missing DACL SDDL: ${lines[1]}`)
    return lines[1]
  } finally {
    try { rmSync(holder, { recursive: true, force: true }) } catch {}
  }
}

// Case 1
test('--send delivers as unverified with no task title', async () => {
  const root = tempRoot()
  let hub
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'claude', session: 'sess-alpha-101', project: 'Alpha', title: 'Secret target title', dir: ws, updatedIso: isoAgo(now, 60_000) }),
      autoBlock({ agent: 'codex', session: 'sess-sender-102', project: 'Alpha', title: 'Secret sender rollout', dir: ws, updatedIso: isoAgo(now, 30_000) }),
    ].join('\n'))
    const reports = [
      { agent: 'claude', session: 'sess-alpha-101', updated: now - 60_000, dir: ws, title: 'Secret target title' },
      { agent: 'codex', session: 'sess-sender-102', updated: now - 30_000, dir: ws, title: 'Secret sender rollout' },
    ]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    await registerReceiver(hub, { agent: 'claude', session: 'sess-alpha-101', dir: ws })

    const res = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Please review parser'], { cwd: ws })
    assert.equal(res.status, 0, res.stderr)
    assert.ok(res.stdout.startsWith('Sent to Claude Code · Alpha · '), res.stdout)
    assert.ok(!res.stdout.includes('Secret target title'), res.stdout)
    assert.ok(!res.stdout.includes('Secret sender rollout'), res.stdout)

    const { messages } = hub.store.snapshot(Date.now(), reports)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].from, 'unverified')
    assert.equal(messages[0].senderTitle, undefined)
    const polled = await hub.post('poll', {
      connection: hub.store.snapshot(Date.now(), reports).connections[0].id,
      secret: undefined,
    })
    assert.equal(polled.status, 409)

    const fullMsg = { ...parseMessageStore(readFileSync(join(root, 'messages', 'messages.json'), 'utf8'), Date.now()).messages[0], nonce: 'abc123' }
    const text = deliveryText(fullMsg, EN)
    const lines = text.split('\n')
    assert.equal(lines[0], EN.messagesDeliveryAgent('unverified'))
    assert.equal(lines[2], EN.cliSendNoReplyLoop)
    assert.ok(!text.includes('Secret sender rollout'))
    assert.ok(lines.indexOf(EN.cliSendNoReplyLoop) < lines.findIndex(line => line.startsWith('<<<AB-')))
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 2
test('--send ignores session values in the environment', async () => {
  const root = tempRoot()
  let hub
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'codex', session: 'sess-env-201', project: 'RepoEnv', title: 'Private sender task', dir: ws, updatedIso: isoAgo(now) }),
      autoBlock({ agent: 'claude', session: 'sess-target-202', project: 'RepoEnv', title: 'Review task', dir: ws, updatedIso: isoAgo(now) }),
    ].join('\n'))
    const reports = [
      { agent: 'codex', session: 'sess-env-201', updated: now - 60_000, dir: ws, title: 'Private sender task' },
      { agent: 'claude', session: 'sess-target-202', updated: now - 60_000, dir: ws, title: 'Review task' },
    ]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    const targetReg = await registerReceiver(hub, { agent: 'claude', session: 'sess-target-202', dir: ws })

    const spoofEnv = {
      CODEX_THREAD_ID: 'sess-env-201',
      CLAUDE_SESSION_ID: 'sess-env-201',
      AGENT_BOARD_AGENT: 'codex',
      AGENT_BOARD_SESSION_ID: 'sess-env-201',
      AGENT_BOARD_HOST_PID: String(process.ppid),
      AGENT_BOARD_HOST_STARTED: '999999',
    }
    const enRes = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Spoof check'], { cwd: ws, env: spoofEnv })
    assert.equal(enRes.status, 0, enRes.stderr)
    const polledEn = await pollAndAck(hub, targetReg)
    assert.equal(polledEn.length, 1)
    assert.equal(polledEn[0].text, 'Spoof check')

    const stored = parseMessageStore(readFileSync(join(root, 'messages', 'messages.json'), 'utf8'), Date.now()).messages
    assert.equal(stored.length, 1)
    for (const one of stored) {
      assert.equal(one.from, 'unverified')
      assert.equal(one.senderTitle, undefined)
      const renderedEn = deliveryText({ ...one, nonce: one.nonce || '111aaa' }, EN)
      const renderedTw = deliveryText({ ...one, nonce: one.nonce || '111aaa' }, ZH_TW)
      assert.equal(renderedEn.split('\n')[0], EN.messagesDeliveryAgent('unverified'))
      assert.equal(renderedTw.split('\n')[0], ZH_TW.messagesDeliveryAgent('unverified'))
      assert.ok(!renderedEn.includes('Private sender task'))
    }
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 3
test('--send from an authenticated receiver names its task', async () => {
  const root = tempRoot()
  let hub
  try {
    const homeDir = join(root, 'home')
    const ws = join(homeDir, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    const rawSenderTitle = `Fix \`\`\` "${join(homeDir, 'secret', 'file.ts')}"\u0007 now`
    writeFileSync(progressPath, [
      autoBlock({ agent: 'codex', session: 'sess-auth-301', project: 'AuthProj', title: rawSenderTitle, dir: ws, updatedIso: isoAgo(now) }),
      autoBlock({ agent: 'claude', session: 'sess-auth-302', project: 'AuthProj', title: 'Run check', dir: ws, updatedIso: isoAgo(now) }),
    ].join('\n'))

    hub = await startServeHub(root, { progressPath, homeDir })
    const senderReg = await registerReceiver(hub, { agent: 'codex', session: 'sess-auth-301', dir: ws })
    const targetReg = await registerReceiver(hub, { agent: 'claude', session: 'sess-auth-302', dir: ws })

    const res = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Authenticated send'], {
      cwd: ws,
      env: { HOME: homeDir, USERPROFILE: homeDir, XDG_RUNTIME_DIR: join(root, 'runtime'), AGENT_BOARD_CONNECTION_ID: senderReg.id, AGENT_BOARD_CONNECTION_SECRET: senderReg.secret },
    })
    assert.equal(res.status, 0, res.stderr)

    const polled = await pollAndAck(hub, targetReg)
    assert.equal(polled.length, 1)
    assert.equal(polled[0].from, 'codex:sess-auth-301')
    assert.equal(typeof polled[0].senderTitle, 'string')
    assert.ok(polled[0].senderTitle.includes('Fix'), polled[0].senderTitle)
    assert.ok(polled[0].senderTitle.includes("'"), polled[0].senderTitle)
    assert.ok(!polled[0].senderTitle.includes('"'), polled[0].senderTitle)
    assert.ok(!polled[0].senderTitle.includes(homeDir), polled[0].senderTitle)

    const deliveryEn = deliveryText(polled[0], EN)
    const deliveryTw = deliveryText(polled[0], ZH_TW)
    const linesEn = deliveryEn.split('\n')
    const linesTw = deliveryTw.split('\n')
    const safeTitle = asData(polled[0].senderTitle, 120)
    assert.equal(linesEn[0], EN.messagesDeliveryAgent('Codex'))
    assert.equal(linesTw[0], ZH_TW.messagesDeliveryAgent('Codex'))
    assert.equal(linesEn[0].includes('Fix'), false)
    assert.equal(linesEn[2], EN.cliSendNoReplyLoop)
    assert.deepEqual(linesEn.slice(3, 7), [
      EN.dataNote,
      '```text',
      EN.cliSendSenderWithTitle('Codex', safeTitle),
      '```',
    ])
    assert.deepEqual(linesTw.slice(3, 7), [
      ZH_TW.dataNote,
      '```text',
      ZH_TW.cliSendSenderWithTitle('Codex', safeTitle),
      '```',
    ])
    assert.equal(linesEn[5].includes('```'), false)
    assert.ok(linesEn.indexOf(EN.cliSendNoReplyLoop) < linesEn.findIndex(line => line.startsWith('<<<AB-')))
    assert.ok(6 < linesEn.findIndex(line => line.startsWith('<<<AB-')))

    // Receiver credentials supplied while no hub is serving this folder must refuse cleanly.
    const offlineProgress = join(root, 'offline-progress.md')
    const offlineMessages = join(root, 'offline-messages')
    mkdirSync(offlineMessages, { recursive: true })
    writeFileSync(offlineProgress, autoBlock({ agent: 'claude', session: 'sess-off-303', project: 'AuthProj', title: 'Target', dir: ws, updatedIso: isoAgo(now) }))
    let offState = { messages: [], mailboxes: [] }
    offState = enrollMailbox(offState, 'claude', 'sess-off-303', 'cli', now, 600_000)
    writeFileSync(join(offlineMessages, 'messages.json'), JSON.stringify({ version: 2, ...offState }))
    const offlineRes = await runCli(root, ['--lang', 'en', '--progress-file', offlineProgress, '--messages-dir', offlineMessages, '--send', 'claude', 'Should fail'], {
      cwd: ws,
      env: { HOME: homeDir, USERPROFILE: homeDir, XDG_RUNTIME_DIR: join(root, 'runtime'), AGENT_BOARD_CONNECTION_ID: senderReg.id, AGENT_BOARD_CONNECTION_SECRET: senderReg.secret },
    })
    assert.equal(offlineRes.status, 1)
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 4
test('peer-send refuses a sender title from the request', async () => {
  const root = tempRoot()
  let hub
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const reports = [
      { agent: 'codex', session: 'sess-ps-401', updated: now - 10_000, dir: ws, title: 'Hub reported title' },
      { agent: 'claude', session: 'sess-ps-402', updated: now - 10_000, dir: ws, title: 'Target' },
    ]
    hub = await startHub(root, { reportsOf: () => reports })
    const senderReg = await registerReceiver(hub, { agent: 'codex', session: 'sess-ps-401', dir: ws })
    await registerReceiver(hub, { agent: 'claude', session: 'sess-ps-402', dir: ws })
    const digest = workspaceDigestOf(ws)

    const authSpoof = await hub.post('peer-send', {
      agent: 'claude',
      session: 'sess-ps-402',
      text: 'Hi',
      id: 'spoof-auth-1',
      source: senderReg.id,
      secret: senderReg.secret,
      senderTitle: 'Spoofed Title',
      folderDigest: digest,
    })
    assert.equal(authSpoof.status, 409)
    assert.equal(authSpoof.data.error, 'UNKNOWN_FIELD')

    const unverifiedSpoof = await hub.post('peer-send', {
      agent: 'claude',
      session: 'sess-ps-402',
      text: 'Hi',
      id: 'spoof-unverified-1',
      from: 'unverified',
      senderTitle: 'Spoofed Title',
      folderDigest: digest,
    })
    assert.equal(unverifiedSpoof.status, 409)
    assert.equal(unverifiedSpoof.data.error, 'UNKNOWN_FIELD')

    const authValid = await hub.post('peer-send', {
      agent: 'claude',
      session: 'sess-ps-402',
      text: 'From hub report',
      id: 'valid-auth-1',
      source: senderReg.id,
      secret: senderReg.secret,
      folderDigest: digest,
    })
    assert.equal(authValid.status, 200)
    const saved = hub.store.snapshot(Date.now(), reports).messages
    assert.equal(saved.length, 1)
    assert.equal(saved[0].from, 'codex:sess-ps-401')
    assert.equal(saved[0].senderTitle, 'Hub reported title')
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 5
test('--send stops at the pair budget and says why', async () => {
  const root = tempRoot()
  let hub
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, autoBlock({ agent: 'claude', session: 'sess-budget-501', project: 'BudgetRepo', title: 'Receiver', dir: ws, updatedIso: isoAgo(now) }))
    const reports = [{ agent: 'claude', session: 'sess-budget-501', updated: now - 30_000, dir: ws, title: 'Receiver' }]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    const targetReg = await registerReceiver(hub, { agent: 'claude', session: 'sess-budget-501', dir: ws })

    const digest = workspaceDigestOf(ws)
    for (let i = 1; i < PEER_PAIR_BUDGET; i++) {
      const seeded = await hub.post('peer-send', {
        agent: 'claude',
        session: 'sess-budget-501',
        text: `Ping ${i}`,
        id: `budget-seed-${i}`,
        from: 'unverified',
        folderDigest: digest,
      })
      assert.equal(seeded.status, 200, JSON.stringify(seeded.data))
      await pollAndAck(hub, targetReg, `Ack ${i}`)
    }
    const lastAllowed = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', `Ping ${PEER_PAIR_BUDGET}`], { cwd: ws })
    assert.equal(lastAllowed.status, 0, lastAllowed.stderr)
    await pollAndAck(hub, targetReg, `Ack ${PEER_PAIR_BUDGET}`)

    const overEn = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Over budget'], { cwd: ws })
    assert.equal(overEn.status, 1)
    assert.equal(overEn.stderr.trim(), EN.cliSendBudget)

    const overTw = await runCli(root, ['--lang', 'zh-TW', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Over budget TW'], { cwd: ws })
    assert.equal(overTw.status, 1)
    assert.equal(overTw.stderr.trim(), ZH_TW.cliSendBudget)

    // A board-originated message to the session resets the pair budget.
    const boardSend = await hub.post('send', {
      id: 'board-reset-1',
      target: targetReg.id,
      turn: targetReg.turn,
      text: 'Human checkpoint',
    })
    assert.equal(boardSend.status, 200)
    await pollAndAck(hub, targetReg, 'Ack human')

    const afterReset = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Fresh turn'], { cwd: ws })
    assert.equal(afterReset.status, 0, afterReset.stderr)
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 6
test('--message-ack is not a board command', async () => {
  const root = tempRoot()
  try {
    const enAck = await runCli(root, ['--lang', 'en', '--message-ack', 'deadbe', 'Done'])
    assert.equal(enAck.status, 2)
    assert.ok(enAck.stderr.includes(EN.boardUnknownFlag('--message-ack')), enAck.stderr)

    const twAck = await runCli(root, ['--lang', 'zh-TW', '--message-ack', 'deadbe'])
    assert.equal(twAck.status, 2)
    assert.ok(twAck.stderr.includes(ZH_TW.boardUnknownFlag('--message-ack')), twAck.stderr)

    // --send remains the recognized CLI messaging command (fails on base where --send is unknown).
    const enSendMissing = await runCli(root, ['--lang', 'en', '--send'])
    assert.equal(enSendMissing.status, 1)
    assert.equal(enSendMissing.stderr.trim(), EN.cliSendMissingTarget)

    for (const table of [EN, ZH_TW, ZH_CN]) {
      assert.equal('cliSendAckInvalid' in table, false)
      assert.equal('cliSendAckNotFound' in table, false)
      assert.equal('cliSendAcked' in table, false)
      assert.ok(table.localAgentSkill('agent-board').includes('--send'))
      assert.equal(table.localAgentSkill('agent-board').includes('--message-ack'), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 7
test('--send lists ambiguous candidates without task titles', async () => {
  const root = tempRoot()
  try {
    const ws = join(root, 'workspace')
    const messagesDir = join(root, 'messages')
    mkdirSync(ws, { recursive: true })
    mkdirSync(messagesDir, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'claude', session: 'sess-cand-701', project: 'AlphaOne', title: 'SecretAlphaTask C:\\Users\\alice\\alpha.ts', dir: ws, updatedIso: isoAgo(now, 60_000) }),
      autoBlock({ agent: 'claude', session: 'sess-cand-702', project: 'GammaTwo', title: 'SecretGammaTask /home/bob/gamma.ts', dir: ws, updatedIso: isoAgo(now, 120_000) }),
      autoBlock({ agent: 'codex', session: 'sess-cand-703', project: 'Build', title: 'SecretBuildTask', dir: ws, updatedIso: isoAgo(now, 30_000) }),
    ].join('\n'))
    let state = { messages: [], mailboxes: [] }
    state = enrollMailbox(state, 'claude', 'sess-cand-701', 'cli', now, 600_000)
    state = enrollMailbox(state, 'claude', 'sess-cand-702', 'cli', now, 600_000)
    state = enrollMailbox(state, 'codex', 'sess-cand-703', 'cli', now, 600_000)
    writeFileSync(join(messagesDir, 'messages.json'), JSON.stringify({ version: 2, ...state }))

    const ambiguous = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', messagesDir, '--send', 'claude', 'Check status'], { cwd: ws })
    assert.equal(ambiguous.status, 1)
    assert.ok(ambiguous.stderr.startsWith(EN.cliSendAmbiguous('claude')), ambiguous.stderr)
    assert.ok(ambiguous.stderr.includes('Claude Code · AlphaOne · '), ambiguous.stderr)
    assert.ok(ambiguous.stderr.includes('Claude Code · GammaTwo · '), ambiguous.stderr)
    for (const forbidden of ['SecretAlphaTask', 'SecretGammaTask', 'alpha.ts', 'gamma.ts', 'sess-cand-701', 'sess-cand-702']) {
      assert.equal(ambiguous.stderr.includes(forbidden), false, `Leaked ${forbidden} in: ${ambiguous.stderr}`)
    }

    const exact = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', messagesDir, '--send', 'Build', 'Exact match'], { cwd: ws })
    assert.equal(exact.status, 0, exact.stderr)
    assert.ok(exact.stdout.startsWith('Sent to Codex · Build · '), exact.stdout)
    assert.equal(exact.stdout.includes('SecretBuildTask'), false)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 8
test('--send still finds a target by a word of its title', async () => {
  const root = tempRoot()
  try {
    const ws = join(root, 'workspace')
    const messagesDir = join(root, 'messages')
    mkdirSync(ws, { recursive: true })
    mkdirSync(messagesDir, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'claude', session: 'sess-word-801', project: 'SharedRepo', title: 'Refactor authentication middleware', dir: ws, updatedIso: isoAgo(now, 60_000) }),
      autoBlock({ agent: 'codex', session: 'sess-word-802', project: 'SharedRepo', title: 'Polish stylesheet layout', dir: ws, updatedIso: isoAgo(now, 120_000) }),
    ].join('\n'))
    let state = { messages: [], mailboxes: [] }
    state = enrollMailbox(state, 'claude', 'sess-word-801', 'cli', now, 600_000)
    state = enrollMailbox(state, 'codex', 'sess-word-802', 'cli', now, 600_000)
    writeFileSync(join(messagesDir, 'messages.json'), JSON.stringify({ version: 2, ...state }))

    const res = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', messagesDir, '--send', 'authentication', 'Check JWT'], { cwd: ws })
    assert.equal(res.status, 0, res.stderr)
    assert.ok(res.stdout.startsWith('Sent to Claude Code · SharedRepo · '), res.stdout)
    assert.equal(res.stdout.includes('Refactor authentication middleware'), false)

    const saved = parseMessageStore(readFileSync(join(messagesDir, 'messages.json'), 'utf8'), Date.now()).messages
    assert.equal(saved.length, 1)
    assert.equal(saved[0].to, 'claude:sess-word-801')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 9
test('--send retried with the same --id delivers once', async () => {
  const root = tempRoot()
  let hub
  let lostServer
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, autoBlock({ agent: 'claude', session: 'sess-idemp-901', project: 'RetryRepo', title: 'Target task', dir: ws, updatedIso: isoAgo(now) }))
    const reports = [{ agent: 'claude', session: 'sess-idemp-901', updated: now - 30_000, dir: ws, title: 'Target task' }]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    const targetReg = await registerReceiver(hub, { agent: 'claude', session: 'sess-idemp-901', dir: ws })

    const argsFirst = ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'First delivery', '--id', 'stable-retry-001']
    const first = await runCli(root, argsFirst, { cwd: ws })
    assert.equal(first.status, 0, first.stderr)
    const retry = await runCli(root, argsFirst, { cwd: ws })
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(hub.store.snapshot(Date.now(), reports).messages.length, 1)

    const conflict = await hub.post('peer-send', {
      agent: 'claude',
      session: 'sess-idemp-901',
      text: 'Different body',
      id: 'stable-retry-001',
      from: 'unverified',
      folderDigest: workspaceDigestOf(ws),
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.data.error, 'ID_CONFLICT')

    // Saved --id retries still succeed after the recipient acknowledges and leaves the hub.
    await pollAndAck(hub, targetReg, 'Acked before leaving')
    const left = await hub.post('disconnect', { connection: targetReg.id, secret: targetReg.secret, turn: targetReg.turn })
    assert.equal(left.status, 200)
    assert.equal(hub.store.snapshot(Date.now(), reports).connections.length, 0)

    const afterLeave = await runCli(root, argsFirst, { cwd: ws })
    assert.equal(afterLeave.status, 0, afterLeave.stderr)
    assert.ok(afterLeave.stdout.startsWith('Sent to Claude Code · RetryRepo · '), afterLeave.stdout)
    assert.equal(hub.store.snapshot(Date.now(), reports).messages.length, 1)

    const wrongBodyAfterLeave = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Different body', '--id', 'stable-retry-001'], { cwd: ws })
    assert.equal(wrongBodyAfterLeave.status, 1)
    assert.equal(wrongBodyAfterLeave.stderr.trim(), EN.cliSendRefused('ID_CONFLICT'))

    const wrongTargetAfterLeave = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'codex', 'First delivery', '--id', 'stable-retry-001'], { cwd: ws })
    assert.equal(wrongTargetAfterLeave.status, 1)
    assert.equal(wrongTargetAfterLeave.stderr.trim(), EN.cliSendRefused('ID_CONFLICT'))

    // Offline retries with a saved --id also succeed after the target mailbox expires.
    const expRoot = join(root, 'expired')
    const expProgress = join(expRoot, 'progress.md')
    const expMessages = join(expRoot, 'messages')
    mkdirSync(expMessages, { recursive: true })
    writeFileSync(expProgress, autoBlock({ agent: 'claude', session: 'sess-exp-903', project: 'ExpRepo', title: 'Expired mailbox target', dir: ws, updatedIso: isoAgo(now) }))
    let expState = { messages: [], mailboxes: [] }
    expState = enrollMailbox(expState, 'claude', 'sess-exp-903', 'cli', now, 600_000)
    writeFileSync(join(expMessages, 'messages.json'), JSON.stringify({ version: 2, ...expState }))
    const expArgs = ['--lang', 'en', '--progress-file', expProgress, '--messages-dir', expMessages, '--send', 'claude', 'Offline saved', '--id', 'offline-retry-001']
    const expFirst = await runCli(root, expArgs, { cwd: ws })
    assert.equal(expFirst.status, 0, expFirst.stderr)
    const savedExp = JSON.parse(readFileSync(join(expMessages, 'messages.json'), 'utf8'))
    savedExp.mailboxes = savedExp.mailboxes.map(one => ({ ...one, expires: Date.now() - 10_000 }))
    writeFileSync(join(expMessages, 'messages.json'), JSON.stringify(savedExp))

    const expRetry = await runCli(root, expArgs, { cwd: ws })
    assert.equal(expRetry.status, 0, expRetry.stderr)
    assert.ok(expRetry.stdout.startsWith('Sent to Claude Code · ExpRepo · '), expRetry.stdout)

    const expWrongBody = await runCli(root, ['--lang', 'en', '--progress-file', expProgress, '--messages-dir', expMessages, '--send', 'claude', 'Tampered', '--id', 'offline-retry-001'], { cwd: ws })
    assert.equal(expWrongBody.status, 1)
    assert.equal(expWrongBody.stderr.trim(), EN.cliSendRefused('ID_CONFLICT'))

    const expWrongTarget = await runCli(root, ['--lang', 'en', '--progress-file', expProgress, '--messages-dir', expMessages, '--send', 'codex', 'Offline saved', '--id', 'offline-retry-001'], { cwd: ws })
    assert.equal(expWrongTarget.status, 1)
    assert.equal(expWrongTarget.stderr.trim(), EN.cliSendRefused('ID_CONFLICT'))

    // Dropped HTTP response on peer-send reports uncertain status naming the retry --id.
    const lostRoot = join(root, 'lost')
    const lostProgress = join(lostRoot, 'progress.md')
    const lostMessages = join(lostRoot, 'messages')
    const lostRuntime = getSharedRuntimeDir()
    const lostCacheDir = addressFolderFor(lostRuntime)
    mkdirSync(lostMessages, { recursive: true })
    writeFileSync(lostProgress, autoBlock({ agent: 'claude', session: 'sess-lost-902', project: 'LostRepo', title: 'Lost target', dir: ws, updatedIso: isoAgo(now) }))
    let lostState = { messages: [], mailboxes: [] }
    lostState = enrollMailbox(lostState, 'claude', 'sess-lost-902', 'cli', now, 600_000)
    writeFileSync(join(lostMessages, 'messages.json'), JSON.stringify({ version: 2, ...lostState }))
    const lostDigest = workspaceDigestOf(ws)
    lostServer = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (reqUrl.pathname === '/api/ping') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ messagesDirectory: lostMessages, pageAgo: null, wantsKeyedPage: false }))
        return
      }
      if (reqUrl.pathname === '/api/messages/targets') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          connections: [],
          mailboxes: [{ id: mailboxId('claude', 'sess-lost-902'), agent: 'claude', session: 'sess-lost-902', surface: 'cli', turn: 'mailbox', scope: 'mailbox', expires: Date.now() + 600_000, folderDigest: lostDigest }],
        }))
        return
      }
      if (reqUrl.pathname === '/api/messages/peer-send') {
        req.socket.destroy()
        return
      }
      res.writeHead(404).end()
    })
    await new Promise(done => lostServer.listen(0, '127.0.0.1', done))
    const { port: lostPort } = lostServer.address()
    const lostUrl = `http://127.0.0.1:${lostPort}/?t=lost-token`
    const lostLockStore = createMessaging(lostMessages, false)
    try {
      const resolvedLost = resolve(lostProgress)
      writeAddressFile(join(lostCacheDir, addressFileName(resolvedLost)), JSON.stringify({ pid: process.pid, port: lostPort, url: lostUrl, path: resolvedLost, built: '' }))
      lostLockStore.recordOwner(lostPort, lostUrl)
      const lostRes = await runCli(root, ['--lang', 'en', '--progress-file', lostProgress, '--messages-dir', lostMessages, '--send', 'claude', 'Maybe delivered', '--id', 'lost-resp-001'], {
        cwd: ws,
        env: { XDG_RUNTIME_DIR: lostRuntime },
      })
      assert.equal(lostRes.status, 1)
      assert.equal(lostRes.stderr.trim(), EN.cliSendUncertain('lost-resp-001'))
      assert.equal(lostRes.stderr.includes('Not sent'), false)
    } finally {
      lostLockStore.close()
    }
  } finally {
    if (lostServer) await closeServer(lostServer)
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 10
test('--send refuses --id without a value', async () => {
  const root = tempRoot()
  let trackerServer
  let trackerLockStore
  try {
    const messagesDir = join(root, 'messages')
    const runtimeDir = getSharedRuntimeDir()
    const cacheDir = addressFolderFor(runtimeDir)
    const progressPath = join(root, 'progress.md')
    mkdirSync(messagesDir, { recursive: true })
    writeFileSync(progressPath, '## Empty\n')

    let hits = 0
    trackerServer = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise(done => trackerServer.listen(0, '127.0.0.1', done))
    const { port } = trackerServer.address()
    const url = `http://127.0.0.1:${port}/?t=no-hit`
    trackerLockStore = createMessaging(messagesDir, false)
    const resolvedProgress = resolve(progressPath)
    writeAddressFile(join(cacheDir, addressFileName(resolvedProgress)), JSON.stringify({ pid: process.pid, port, url, path: resolvedProgress, built: '' }))
    trackerLockStore.recordOwner(port, url)

    const uncreatedDir = join(root, 'must-not-read-or-create')
    const forms = [
      ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', uncreatedDir, '--send', 'codex', 'hello', '--id'],
      ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', uncreatedDir, '--send', 'codex', 'hello', '--id', '--cross-project'],
      ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', uncreatedDir, '--id', '--cross-project'],
      ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', uncreatedDir, '--send', 'codex', 'hello', '--id', 'invalid/id!'],
    ]
    for (const cliArgs of forms) {
      const res = await runCli(root, cliArgs, { env: { XDG_RUNTIME_DIR: runtimeDir } })
      assert.equal(res.status, 1, `Expected exit 1 for ${cliArgs.join(' ')}`)
      assert.equal(res.stdout, '', `Expected empty stdout for ${cliArgs.join(' ')}`)
      assert.equal(res.stderr.trim(), EN.boardUsage.trim())
    }
    assert.equal(hits, 0)
    assert.equal(existsSync(uncreatedDir), false)
  } finally {
    if (trackerLockStore) trackerLockStore.close()
    if (trackerServer) await closeServer(trackerServer)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 11
test('--send offline makes the default message folder private on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = tempRoot()
  try {
    const homeDir = join(root, 'home')
    const claudeDir = join(homeDir, '.claude')
    const ws = join(root, 'workspace')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(claudeDir, 'progress.md')
    writeFileSync(progressPath, autoBlock({ agent: 'claude', session: 'sess-acl-11', project: 'WinAclRepo', title: 'ACL target', dir: ws, updatedIso: isoAgo(now) }))

    const env = baseChildEnv(root, { HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: claudeDir }, ['XDG_RUNTIME_DIR', 'AGENT_BOARD_MESSAGE_FOLDER'])
    const defaultDir = defaultMessagesDirectory(progressPath, homeDir, env, 'win32')
    mkdirSync(defaultDir, { recursive: true })
    let state = { messages: [], mailboxes: [] }
    state = enrollMailbox(state, 'claude', 'sess-acl-11', 'cli', now, 600_000)
    writeFileSync(join(defaultDir, 'messages.json'), JSON.stringify({ version: 2, ...state }))

    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
    execFileSync(icacls, [defaultDir, '/grant', '*S-1-1-0:(OI)(CI)F', '/L'], { encoding: 'utf8', windowsHide: true })
    const beforeDacl = readDaclSddl(defaultDir)
    assert.ok(beforeDacl.includes('WD'), beforeDacl)

    const res = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--send', 'claude', 'Offline private check'], {
      cwd: ws,
      env: { HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: claudeDir },
      omit: ['XDG_RUNTIME_DIR', 'AGENT_BOARD_MESSAGE_FOLDER'],
    })
    assert.equal(res.status, 0, res.stderr)

    const whoami = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const acc = runningAccount(whoami, process.env.COMPUTERNAME ?? '', hostname())
    assert.ok(acc, `Could not parse account from whoami: ${whoami}`)
    const afterDacl = readDaclSddl(defaultDir)
    assert.equal(afterDacl.includes('WD'), false, afterDacl)
    assert.equal(isPrivateDacl(afterDacl, acc.sid, acc.own), true, afterDacl)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Case 12
test('--send refuses cross-project agent sends unless --cross-project is given', async () => {
  const root = tempRoot()
  let hub
  try {
    const repoOne = join(root, 'repo-one')
    const repoTwo = join(root, 'repo-two')
    mkdirSync(repoOne, { recursive: true })
    mkdirSync(repoTwo, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'codex', session: 'sess-cp-1', project: 'RepoOne', title: 'Sender', dir: repoOne, updatedIso: isoAgo(now) }),
      autoBlock({ agent: 'claude', session: 'sess-cp-2', project: 'RepoTwo', title: 'Target', dir: repoTwo, updatedIso: isoAgo(now) }),
    ].join('\n'))
    const reports = [
      { agent: 'codex', session: 'sess-cp-1', updated: now - 30_000, dir: repoOne, title: 'Sender' },
      { agent: 'claude', session: 'sess-cp-2', updated: now - 30_000, dir: repoTwo, title: 'Target' },
    ]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    const targetReg = await registerReceiver(hub, { agent: 'claude', session: 'sess-cp-2', dir: repoTwo })

    const blocked = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Cross Blocked'], { cwd: repoOne })
    assert.equal(blocked.status, 1)
    assert.equal(blocked.stderr.trim(), EN.cliSendCrossProject)

    const received = []
    const flagAsBody = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', '--json', '--cross-project'], { cwd: repoOne })
    assert.equal(flagAsBody.status, 0, flagAsBody.stderr)
    assert.ok(flagAsBody.stdout.startsWith('Sent to Claude Code · RepoTwo · '), flagAsBody.stdout)
    received.push(...(await pollAndAck(hub, targetReg)).map(one => one.text))

    const dashDashBody = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--cross-project', '--send', 'claude', '--', '--json'], { cwd: repoOne })
    assert.equal(dashDashBody.status, 0, dashDashBody.stderr)
    received.push(...(await pollAndAck(hub, targetReg)).map(one => one.text))

    assert.deepEqual(received, ['--json', '--json'])
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Retained 13
test('--send stops a reply loop at HOP_LIMIT for an authenticated receiver', async () => {
  const root = tempRoot()
  let hub
  try {
    const ws = join(root, 'workspace')
    mkdirSync(ws, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'codex', session: 'sess-hop-a', project: 'HopRepo', title: 'Agent A', dir: ws, updatedIso: isoAgo(now) }),
      autoBlock({ agent: 'claude', session: 'sess-hop-b', project: 'HopRepo', title: 'Agent B', dir: ws, updatedIso: isoAgo(now) }),
    ].join('\n'))
    const reports = [
      { agent: 'codex', session: 'sess-hop-a', updated: now - 30_000, dir: ws, title: 'Agent A' },
      { agent: 'claude', session: 'sess-hop-b', updated: now - 30_000, dir: ws, title: 'Agent B' },
    ]
    hub = await startHub(root, { progressPath, reportsOf: () => reports })
    const regA = await registerReceiver(hub, { agent: 'codex', session: 'sess-hop-a', dir: ws })
    const regB = await registerReceiver(hub, { agent: 'claude', session: 'sess-hop-b', dir: ws })

    const hop1 = await hub.post('peer-send', {
      agent: 'claude',
      session: 'sess-hop-b',
      text: 'Hop 1',
      id: 'hop-seed-1',
      source: regA.id,
      secret: regA.secret,
      folderDigest: workspaceDigestOf(ws),
    })
    assert.equal(hop1.status, 200, JSON.stringify(hop1.data))
    await pollAndAck(hub, regB)

    const hop2 = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'codex', 'Hop 2'], {
      cwd: ws,
      env: { AGENT_BOARD_CONNECTION_ID: regB.id, AGENT_BOARD_CONNECTION_SECRET: regB.secret },
    })
    assert.equal(hop2.status, 0, hop2.stderr)
    await pollAndAck(hub, regA)

    const hop3 = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', join(root, 'messages'), '--send', 'claude', 'Hop 3 blocked'], {
      cwd: ws,
      env: { AGENT_BOARD_CONNECTION_ID: regA.id, AGENT_BOARD_CONNECTION_SECRET: regA.secret },
    })
    assert.equal(hop3.status, 1)
    assert.equal(hop3.stderr.trim(), EN.cliSendHopLimit(HOP_LIMIT))
    assert.equal(hub.store.snapshot(Date.now(), reports).messages.length, HOP_LIMIT)
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Retained 14
test('terminal print and --chat show the latest message state without exposing session ids or nonces', async () => {
  const root = tempRoot()
  try {
    const ws = join(root, 'workspace')
    const messagesDir = join(root, 'messages')
    mkdirSync(ws, { recursive: true })
    mkdirSync(messagesDir, { recursive: true })
    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    const rows = [
      { agent: 'codex', session: 'sess-leak-sender-0', project: 'ProjFrom', title: 'Sender Task' },
      { agent: 'claude', session: 'sess-leak-q-1', project: 'ProjQueued', title: 'Queued Task' },
      { agent: 'gemini', session: 'sess-leak-a-2', project: 'ProjAccepted', title: 'Accepted Task' },
      { agent: 'cursor', session: 'sess-leak-ok-3', project: 'ProjAcked', title: 'Acked Task' },
      { agent: 'codex', session: 'sess-leak-u-4', project: 'ProjUncertain', title: 'Uncertain Task' },
      { agent: 'claude', session: 'sess-leak-r-5', project: 'ProjRejected', title: 'Rejected Task' },
    ]
    writeFileSync(progressPath, rows.map(r => autoBlock({ ...r, dir: ws, updatedIso: isoAgo(now) })).join('\n'))

    const senderAddr = address('codex', 'sess-leak-sender-0')
    const messages = [
      {
        id: 'st-queued',
        target: 'conn-q',
        turn: 't1',
        from: senderAddr,
        to: address('claude', 'sess-leak-q-1'),
        text: 'queued body',
        hash: textHash('queued body'),
        origin: 'local',
        hops: 1,
        claimed: 0,
        nonce: '',
        framingNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        status: 'queued',
        updated: now - 10_000,
        reply: '',
        error: '',
      },
      {
        id: 'st-accepted',
        target: 'conn-a',
        turn: 't1',
        from: 'board',
        to: address('gemini', 'sess-leak-a-2'),
        text: 'accepted body',
        hash: textHash('accepted body'),
        origin: 'local',
        hops: 1,
        claimed: now - 9_000,
        nonce: 'aa11bb',
        status: 'accepted',
        updated: now - 8_000,
        reply: '',
        error: '',
      },
      {
        id: 'st-acked',
        target: 'conn-ok',
        turn: 't1',
        from: 'board',
        to: address('cursor', 'sess-leak-ok-3'),
        text: 'acked body',
        hash: textHash('acked body'),
        origin: 'local',
        hops: 1,
        claimed: now - 7_000,
        nonce: 'cc22dd',
        status: 'acknowledged',
        updated: now - 6_000,
        reply: 'Finished check',
        error: '',
      },
      {
        id: 'st-uncertain',
        target: 'conn-u',
        turn: 't1',
        from: 'board',
        to: address('codex', 'sess-leak-u-4'),
        text: 'uncertain body',
        hash: textHash('uncertain body'),
        origin: 'local',
        hops: 1,
        claimed: now - 5_000,
        nonce: 'ee33ff',
        status: 'uncertain',
        updated: now - 4_000,
        reply: '',
        error: 'LOST',
      },
      {
        id: 'st-rejected',
        target: 'conn-r',
        turn: 't1',
        from: 'board',
        to: address('claude', 'sess-leak-r-5'),
        text: 'rejected body',
        hash: textHash('rejected body'),
        origin: 'local',
        hops: 1,
        claimed: 0,
        nonce: '',
        status: 'rejected',
        updated: now - 3_000,
        reply: '',
        error: 'OFFLINE',
      },
    ]
    // Ensure a valid claimMessages reference exists on store types too.
    assert.equal(typeof claimMessages, 'function')
    assert.equal(typeof queueMessage, 'function')
    writeFileSync(join(messagesDir, 'messages.json'), JSON.stringify({ version: 2, messages, mailboxes: [] }))

    const printRes = await runCli(root, ['--lang', 'en', '--print', '--no-color', '--progress-file', progressPath, '--messages-dir', messagesDir])
    assert.equal(printRes.status, 0, printRes.stderr)
    const chatRes = await runCli(root, ['--lang', 'en', '--chat', '--no-color', '--progress-file', progressPath, '--messages-dir', messagesDir])
    assert.equal(chatRes.status, 0, chatRes.stderr)

    for (const out of [printRes.stdout, chatRes.stdout]) {
      assert.ok(out.includes('ProjFrom'), out)
      assert.ok(out.includes(EN.messagesQueued), out)
      assert.ok(out.includes(EN.messagesAccepted), out)
      assert.ok(out.includes(EN.messagesAcknowledged), out)
      assert.ok(out.includes(EN.messagesUncertain), out)
      assert.ok(out.includes(EN.messagesRejected), out)
      for (const secret of ['sess-leak-', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'aa11bb', 'cc22dd', 'ee33ff']) {
        assert.equal(out.includes(secret), false, `Exposed ${secret} in:\n${out}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// Retained 15
test('--send matches same-workspace MCP mailbox alongside a live connection and across symlinked paths', async () => {
  const root = tempRoot()
  let hub
  try {
    const homeDir = join(root, 'home')
    const realWs = join(root, 'real-ws')
    const aliasWs = join(root, 'alias-ws')
    const messagesDir = join(root, 'messages')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(realWs, { recursive: true })
    symlinkSync(realWs, aliasWs, process.platform === 'win32' ? 'junction' : 'dir')

    const now = Date.now()
    const progressPath = join(root, 'progress.md')
    writeFileSync(progressPath, [
      autoBlock({ agent: 'gemini', session: 'sess-mcp-15', project: 'SymlinkRepo', title: 'MCP + Live', dir: realWs, updatedIso: isoAgo(now) }),
      autoBlock({ agent: 'codex', session: 'sess-alias-16', project: 'SymlinkRepo', title: 'Alias Cwd', dir: aliasWs, updatedIso: isoAgo(now) }),
    ].join('\n'))

    hub = await startServeHub(root, { progressPath, messagesDir, runtimeDir, homeDir })
    const canonicalDigest = workspaceDigestOf(realpathSync(aliasWs))
    assert.equal(workspaceDigestOf(aliasWs), canonicalDigest)

    const enroll = await hub.post('mcp-enroll', {
      agent: 'gemini',
      session: 'sess-mcp-15',
      surface: 'mcp',
      owner: '12345:133000000000000000',
      folderDigest: canonicalDigest,
      until: Date.now() + 300_000,
    })
    assert.equal(enroll.status, 200, JSON.stringify(enroll.data))
    const liveReg = await registerReceiver(hub, { agent: 'gemini', session: 'sess-mcp-15', dir: realWs, surface: 'ide' })

    const sendRes = await runCli(root, ['--lang', 'en', '--progress-file', progressPath, '--messages-dir', messagesDir, '--send', 'gemini', 'Symlink workspace hello'], {
      cwd: aliasWs,
      env: { HOME: homeDir, USERPROFILE: homeDir, XDG_RUNTIME_DIR: runtimeDir },
    })
    assert.equal(sendRes.status, 0, sendRes.stderr)

    // Live connection is preferred over the co-resident MCP mailbox.
    const livePolled = await pollAndAck(hub, liveReg)
    assert.equal(livePolled.length, 1)
    assert.equal(livePolled[0].text, 'Symlink workspace hello')

    // Offline symlinked --messages-dir must be refused as UNSAFE_MESSAGE_DIRECTORY.
    const unsafeDir = join(root, 'symlink-messages')
    const targetDir = join(root, 'real-offline-messages')
    mkdirSync(targetDir, { recursive: true })
    symlinkSync(targetDir, unsafeDir, process.platform === 'win32' ? 'junction' : 'dir')
    const offlineProgress = join(root, 'offline-sym.md')
    writeFileSync(offlineProgress, autoBlock({ agent: 'codex', session: 'sess-sym-off', project: 'SymOff', title: 'Offline', dir: realWs, updatedIso: isoAgo(now) }))
    const unsafeRes = await runCli(root, ['--lang', 'en', '--progress-file', offlineProgress, '--messages-dir', unsafeDir, '--send', 'codex', 'Refused symlink'], {
      cwd: realWs,
      env: { HOME: homeDir, USERPROFILE: homeDir, XDG_RUNTIME_DIR: runtimeDir },
    })
    assert.equal(unsafeRes.status, 1)
    assert.ok(unsafeRes.stderr.includes('UNSAFE_MESSAGE_DIRECTORY'), unsafeRes.stderr)
  } finally {
    if (hub) await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

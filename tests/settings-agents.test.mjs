import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'
import { setupAgents } from '../scripts/setup-discovery.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const sourceLoader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const { settingsPanel, settingsScript, settingsCss } = await import('../hooks/page-settings.ts')
const { settingsAgentState } = await import('../hooks/settings-agents.ts')
sourceLoader.deregister()

const transport = (url, method, path, body, headers = {}) => new Promise((done, fail) => {
  const req = request({
    hostname: '127.0.0.1', port: url.port, method, path, agent: false,
    headers: { host: url.host, 'x-board-token': url.searchParams.get('t'), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  }, res => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { text += chunk })
    res.on('end', () => done({ status: res.statusCode, text, json: () => JSON.parse(text) }))
  })
  req.setTimeout(10_000, () => req.destroy(new Error('Synthetic settings request timed out')))
  req.on('error', fail)
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

const fixture = (isLan = false) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-settings-agents-'))
  const home = join(root, 'home')
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  mkdirSync(home)
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'DSH_HOME', 'TMP', 'TEMP', 'TMPDIR']) {
    env[name] = join(home, name)
    mkdirSync(env[name], { recursive: true, mode: 0o700 })
  }
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID', 'AGENT_BOARD_SETUP_TTY', 'AGENT_BOARD_TEST_CODEX_FAIL', 'AGENT_BOARD_TEST_CLAUDE_FAIL']) delete env[name]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  env.AGENT_BOARD_SETUP_COMMAND = ''
  env.AGENT_BOARD_TEST_PID = String(process.pid)
  const data = join(home, '.agent-board')
  const progress = join(data, 'progress.md')
  env.CLAUDE_PROGRESS_FILE = progress
  mkdirSync(data)
  writeFileSync(progress, '# Progress\n\n## Synthetic project\n')
  const script = join(root, 'start.mjs')
  // Both listeners stay on loopback; the second exercises the actual LAN handler and policy.
  const lanPrelude = isLan ? `
import syntheticOs from 'node:os'
import { Server as SyntheticServer } from 'node:net'
import { syncBuiltinESMExports as syntheticSync } from 'node:module'
syntheticOs.networkInterfaces = () => ({ synthetic: [{ address: '192.168.42.2', family: 'IPv4', internal: false }] })
const syntheticListen = SyntheticServer.prototype.listen
SyntheticServer.prototype.listen = function (...args) {
  if (args[1] === '192.168.42.2') args[1] = '127.0.0.1'
  return Reflect.apply(syntheticListen, this, args)
}
syntheticSync()
` : ''
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, codexRoot: data, lang: 'en' })}\n${lanPrelude}${BOARD_SCRIPT}`)
  const common = ['--home', home, '--data-dir', data, '--progress-file', progress, '--lang', 'en', '--json']
  const command = (file, args) => {
    const result = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr || String(result.error))
    return JSON.parse(result.stdout)
  }
  const start = async (...args) => {
    const child = spawn(process.execPath, [script, '--serve-child', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = new Promise(done => child.once('exit', done))
    const url = await new Promise((done, fail) => {
      let out = ''
      const timeout = setTimeout(() => { child.kill(); fail(new Error('Synthetic board did not start: ' + stderr)) }, 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        out += chunk
        if (out.includes('\n')) { clearTimeout(timeout); done(new URL(out.split('\n')[0].trim())) }
      })
      child.once('error', error => { clearTimeout(timeout); fail(error) })
      exited.then(code => { clearTimeout(timeout); fail(new Error(`Synthetic board exited ${code}: ${stderr}`)) })
    })
    const call = (method, path, body, headers) => transport(url, method, path, body, headers)
    return {
      call, url,
      close: async () => {
        await call('POST', '/api/close', {}).catch(() => { child.kill() })
        assert.equal(await exited, 0, stderr)
      },
    }
  }
  return { root, home, data, env, progress, script, start, setup: (...args) => command(installer, [...common, ...args]), local: (...args) => command(script, [...common, ...args]) }
}

const files = directory => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  // Runtime addresses, message leases and bootstrap scratch files are not installer output.
  if (['XDG_RUNTIME_DIR', 'TMP', 'TEMP', 'TMPDIR'].includes(entry.name)) return []
  const path = join(directory, entry.name)
  return entry.isDirectory() ? Object.entries(files(path)).map(([name, text]) => [join(entry.name, name), text]) : [[entry.name, readFileSync(path, 'utf8')]]
}).sort(([left], [right]) => left.localeCompare(right)))

const block = (agent, session = 'a1b2c3d4') => `<!-- auto session=${session} agent=${agent} state=working updated=2020-01-01T00:00:00Z -->\n### Synthetic work\n- [~] Work\n<!-- /auto session=${session} -->\n`

const nativeCodex = f => {
  const bin = join(f.root, 'synthetic bin')
  if (process.platform !== 'win32') return join(bin, 'codex')
  const executable = join(bin, 'codex.exe')
  const standIn = join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  writeFileSync(executable, 'synthetic executable')
  const prelude = `import syntheticChild from 'node:child_process'
import { syncBuiltinESMExports as syncSyntheticChild } from 'node:module'
const spawnSyntheticChild = syntheticChild.spawn
syntheticChild.spawn = (file, args, options) => file === ${JSON.stringify(executable)}
  ? spawnSyntheticChild(process.execPath, [${JSON.stringify(standIn)}, ...args], options)
  : spawnSyntheticChild(file, args, options)
syncSyntheticChild()
`
  writeFileSync(f.script, prelude + readFileSync(f.script, 'utf8'))
  return executable
}

// Claude Code's own records of the board plugin: its install receipt and the user's enable switch.
const claudePlugin = (f, { installed, enabled }) => {
  if (installed) {
    mkdirSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true })
    writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-board@agent-board': [{ scope: 'user' }] } }))
  }
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ enabledPlugins: { 'agent-board@agent-board': enabled } }))
}

test('Settings agent states follow their order in all three languages', () => {
  for (const words of [EN, ZH_TW, ZH_CN]) {
    assert.deepEqual(settingsAgentState(true, true, true, true, words), { state: words.settingsAgentOnBoard, button: 'remove' })
    assert.deepEqual(settingsAgentState(true, false, true, true, words), { state: words.settingsAgentApproval, button: 'setup' })
    assert.deepEqual(settingsAgentState(true, false, false, false, words), { state: words.settingsAgentStart, button: 'remove' })
    assert.deepEqual(settingsAgentState(false, true, false, true, words), { state: words.settingsAgentNotSetUp, button: 'setup' })
    assert.deepEqual(settingsAgentState(false, false, false, false, words), { state: words.settingsAgentNotInstalled, button: null })
  }
})

test('Settings Agents heading is translated in zh-TW and zh-CN (#1269)', () => {
  assert.equal(ZH_TW.settingsAgents, '代理程式')
  assert.equal(ZH_CN.settingsAgents, '代理')
  for (const words of [ZH_TW, ZH_CN]) {
    assert.notEqual(words.settingsAgents, EN.settingsAgents)
  }
})

test('Settings setup confirmations describe files and hook approval', () => {
  assert.equal(EN.settingsAgentSetupConfirm('Codex', 1, true), 'Set up Codex? Setup will change 1 file. It also approves the board’s hooks.')
  assert.equal(EN.settingsAgentSetupConfirm('Codex', 2, true), 'Set up Codex? Setup will change 2 files. It also approves the board’s hooks.')
  assert.equal(EN.settingsAgentSetupConfirm('Cursor', 1, false), 'Set up Cursor? Setup will change 1 file.')
  assert.equal(EN.settingsAgentSetupConfirm('Cursor', 2, false), 'Set up Cursor? Setup will change 2 files.')
  assert.equal(EN.settingsAgentSetupConfirm('Codex', 0, true), 'Approve the board’s hooks for Codex?')
  assert.equal(EN.settingsAgentSetupConfirm('Cursor', 0, false), 'Set up Cursor? No files need to change.')
  assert.equal(ZH_TW.settingsAgentSetupConfirm('Codex', 0, true), '要核准 Codex 使用看板的 hooks 嗎？')
  assert.equal(ZH_CN.settingsAgentSetupConfirm('Codex', 0, true), '要批准 Codex 使用看板的 hooks 吗？')
})

test('Settings keeps every agent and caches detection when the Codex hooks check fails', { timeout: 30_000 }, async () => {
  for (const isExplicit of [false, true]) {
    const f = fixture()
    const programs = setupPrograms(f.root, f.env, ['codex'])
    const executable = nativeCodex(f)
    const standIn = process.platform === 'win32' ? join(f.root, 'synthetic bin', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : executable
    const source = readFileSync(standIn, 'utf8')
    const hookCheck = "if (message.method === 'hooks/list') {"
    assert.ok(source.includes(hookCheck))
    writeFileSync(standIn, source.replace(hookCheck, `if (message.method === 'hooks/list') {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'synthetic hooks failure' } }) + '\\n')
    return
  }
  ${hookCheck}`), { mode: 0o755 })
    f.local('--codex-setup', '--agent', 'codex', '--apply')
    programs.clear()
    const board = await f.start(...(isExplicit ? ['--codex-bin', executable] : []))
    try {
      for (let i = 0; i < 2; i++) {
        const result = await board.call('GET', '/api/agents')
        assert.equal(result.status, 200, result.text)
        assert.deepEqual(result.json().rows.map(row => row.agent), setupAgents)
      }
      assert.equal(programs.calls().filter(call => call.method === 'hooks/list').length, 1, 'a failing check is cached')
    } finally { await board.close() }
  }
})

test('Settings keeps every agent when the Codex doctor itself throws', { timeout: 25_000 }, async () => {
  const f = fixture()
  f.local('--codex-setup', '--agent', 'codex', '--apply')
  const manifest = join(f.data, 'install-codex.json')
  const record = JSON.parse(readFileSync(manifest, 'utf8'))
  record.groups = []
  writeFileSync(manifest, JSON.stringify(record))
  const board = await f.start()
  try {
    const result = await board.call('GET', '/api/agents')
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.json().rows.map(row => row.agent), setupAgents)
    assert.equal(result.json().rows.find(row => row.agent === 'codex').state, EN.settingsAgentStart)
  } finally { await board.close() }
})

test('Settings keeps every agent row when an install record or the connect record cannot be read', { timeout: 35_000 }, async () => {
  const f = fixture()
  f.setup('--agent', 'gemini', '--apply')
  writeFileSync(join(f.data, 'install-cursor.json'), '{')
  writeFileSync(join(f.data, 'install-opencode.json'), JSON.stringify({ files: [] }))
  // A folder where the record should be exists but cannot be read as a file.
  mkdirSync(join(f.data, 'install-grok.json'))
  // Copied Claude settings that enable the plugin are not an install: no Claude row (#1203).
  claudePlugin(f, { installed: false, enabled: true })
  let board = await f.start()
  try {
    const result = await board.call('GET', '/api/agents')
    assert.equal(result.status, 200, result.text)
    const rows = result.json().rows
    assert.deepEqual(rows.map(row => row.agent), setupAgents)
    for (const agent of ['cursor', 'opencode', 'grok']) {
      const row = rows.find(one => one.agent === agent)
      assert.equal(row.note, EN.setupErrorRecord(`install-${agent}.json`), agent)
      assert.deepEqual({ state: row.state, button: row.button }, { state: EN.settingsAgentStart, button: 'remove' }, agent)
    }
    assert.equal(rows.find(row => row.agent === 'gemini').note, undefined)
    // A press on a damaged row gets setup's own refusal for that record and changes nothing in the home.
    const before = files(f.home)
    for (const request of [() => board.call('GET', '/api/agents?agent=cursor&action=remove'), () => board.call('POST', '/api/agents/remove', { agent: 'cursor' })]) {
      const pressed = await request()
      assert.equal(pressed.status, 409, pressed.text)
      assert.equal(pressed.json().note, EN.setupErrorRecord('install-cursor.json'))
      assert.deepEqual(files(f.home), before)
    }
  } finally { await board.close() }
  // A damaged connect record does not hide the rows either. An installed plugin that the
  // person turned off is not shown as set up, as setup reads it (#1203).
  writeFileSync(join(f.data, 'legacy-connect.json'), 'not json')
  claudePlugin(f, { installed: true, enabled: false })
  board = await f.start()
  try {
    const result = await board.call('GET', '/api/agents')
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.json().rows.map(row => row.agent), setupAgents)
  } finally { await board.close() }
})

test('Settings sets up an agent in the home and data folder a normal --serve start was given', { timeout: 40_000 }, async () => {
  const f = fixture()
  const other = join(f.root, 'other home')
  const otherData = join(other, '.agent-board')
  const otherProgress = join(otherData, 'progress.md')
  mkdirSync(join(other, '.cursor'), { recursive: true })
  mkdirSync(otherData)
  writeFileSync(otherProgress, '# Progress\n\n## Synthetic project\n')
  const out = await new Promise((done, fail) => execFile(process.execPath, [f.script, '--serve', '--no-open', '--home', other, '--data-dir', otherData, '--progress-file', otherProgress, '--lang', 'en'], { env: f.env, encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout) => (error ? fail(error) : done(stdout))))
  const address = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)?.[0]
  assert.ok(address, out)
  const url = new URL(address)
  try {
    const added = await transport(url, 'POST', '/api/agents/setup', { agent: 'cursor' })
    assert.equal(added.status, 200, added.text)
    assert.ok(existsSync(join(otherData, 'install-cursor.json')), 'setup keeps its record in the data folder the start was given')
    assert.ok(!existsSync(join(f.data, 'install-cursor.json')), 'nothing is set up in the account home')
    assert.ok(!existsSync(join(f.home, '.cursor')), 'nothing is set up in the account home')
  } finally {
    await transport(url, 'POST', '/api/close', {}).catch(() => undefined)
    // The detached page exits once closed; wait until it no longer answers, on Windows too.
    for (let tries = 0; tries < 50 && await transport(url, 'GET', '/api/agents').then(() => true, () => false); tries++) await new Promise(done => setTimeout(done, 100))
  }
})

test('Settings directs connector-managed agent removal back to Claude Code', { timeout: 25_000 }, async () => {
  for (const hasOtherInstall of [false, true]) {
    const f = fixture()
    if (hasOtherInstall) f.setup('--agent', 'gemini', '--apply')
    writeFileSync(join(f.data, 'legacy-connect.json'), JSON.stringify({
      version: 1, revision: 1, disabled: false, owned: {}, notified: [], connectedProgress: f.progress,
      setup: { agents: [
        { agent: 'cursor', label: 'Cursor', hook: 'configured', board: 'ready' },
        ...(hasOtherInstall ? [{ agent: 'gemini', label: 'Gemini', hook: 'configured', board: 'ready' }] : []),
      ], problems: [], node: null },
    }))
    const board = await f.start()
    try {
      const rows = await board.call('GET', '/api/agents')
      assert.equal(rows.status, 200, rows.text)
      const cursor = rows.json().rows.find(row => row.agent === 'cursor')
      assert.equal(cursor.state, EN.settingsAgentStart)
      assert.equal(cursor.note, EN.settingsAgentConnector('Cursor'))
      if (hasOtherInstall) assert.equal(rows.json().rows.find(row => row.agent === 'gemini').note, undefined)
      const before = files(f.home)
      for (const request of [() => board.call('GET', '/api/agents?agent=cursor&action=remove'), () => board.call('POST', '/api/agents/remove', { agent: 'cursor' })]) {
        const result = await request()
        assert.equal(result.status, 409, result.text)
        assert.equal(result.json().note, EN.settingsAgentConnector('Cursor'))
        assert.deepEqual(files(f.home), before)
      }
    } finally { await board.close() }
  }
})

test('Settings detects real synthetic installs once, trusts Codex and Hermes, refuses concurrent presses and guards the phone routes', { timeout: 30_000 }, async () => {
  const f = fixture(true)
  const programs = setupPrograms(f.root, f.env, ['codex'])
  const executable = nativeCodex(f)
  const codex = join(f.root, 'synthetic bin', ...(process.platform === 'win32' ? ['node_modules', '@openai', 'codex', 'bin', 'codex.js'] : ['codex']))
  const script = readFileSync(codex, 'utf8')
  const output = "process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')"
  assert.ok(script.includes(output))
  writeFileSync(codex, script.replace(output, `setTimeout(() => ${output}, Number(process.env.AGENT_BOARD_TEST_DELAY || 0))`), { mode: 0o755 })
  for (const agent of ['codex', 'opencode', 'gemini']) f.local('--codex-setup', '--agent', agent, '--apply')
  mkdirSync(join(f.home, '.cursor'))
  claudePlugin(f, { installed: true, enabled: true })
  writeFileSync(f.progress, '# Progress\n\n## Synthetic project\n' + block('opencode'))
  f.env.AGENT_BOARD_TEST_DELAY = '100'
  programs.clear()
  const board = await f.start('--codex-bin', executable)
  try {
    const getRows = async () => {
      const result = await board.call('GET', '/api/agents')
      assert.equal(result.status, 200, result.text)
      return result.json().rows
    }
    const first = await getRows()
    assert.deepEqual(first.map(row => row.agent), [...setupAgents, 'claude'])
    const row = (rows, agent) => rows.find(one => one.agent === agent)
    assert.equal(row(first, 'antigravity').state, EN.settingsAgentNotInstalled)
    assert.equal(row(first, 'cursor').state, EN.settingsAgentNotSetUp)
    assert.equal(row(first, 'opencode').state, EN.settingsAgentOnBoard)
    assert.equal(row(first, 'gemini').state, EN.settingsAgentStart)
    assert.equal(row(first, 'codex').state, EN.settingsAgentApproval)
    assert.equal(row(first, 'claude').state, EN.settingsAgentStart)
    const codexPreview = await board.call('GET', '/api/agents?agent=codex&action=setup')
    assert.equal(codexPreview.status, 200, codexPreview.text)
    assert.equal(codexPreview.json().note, EN.settingsAgentSetupConfirm('Codex', codexPreview.json().count, true))
    const checks = () => programs.calls().filter(call => call.method === 'hooks/list').length
    const before = checks()
    assert.equal(before, 1)
    await getRows()
    writeFileSync(f.progress, readFileSync(f.progress, 'utf8') + block('codex', 'b2c3d4e5'))
    assert.equal(row(await getRows(), 'codex').state, EN.settingsAgentOnBoard, 'an old block wins over untrusted hooks without waiting for detection')
    assert.equal(checks(), before, 'polling uses the ten-second detection cache')
    writeFileSync(f.progress, '# Progress\n\n## Synthetic project\n' + block('opencode'))
    const setup = board.call('POST', '/api/agents/setup', { agent: 'codex' })
    const deadline = Date.now() + 5000
    while (checks() === before && Date.now() < deadline) await new Promise(done => setTimeout(done, 10))
    assert.ok(checks() > before, 'Codex approval reached the synthetic host')
    const busy = await board.call('POST', '/api/agents/remove', { agent: 'opencode' })
    assert.equal(busy.status, 409)
    assert.equal(busy.json().note, EN.settingsAgentsBusy)
    const approved = await setup
    assert.equal(approved.status, 200, approved.text)
    assert.ok(existsSync(join(f.env.CODEX_HOME, 'synthetic-trust.json')))
    assert.equal(row(await getRows(), 'codex').state, EN.settingsAgentStart)
    const hermes = await board.call('POST', '/api/agents/setup', { agent: 'hermes' })
    assert.equal(hermes.status, 200, hermes.text)
    assert.ok(JSON.parse(readFileSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json'), 'utf8')).approvals.length > 0)
    const hermesPreview = await board.call('GET', '/api/agents?agent=hermes&action=setup')
    assert.equal(hermesPreview.status, 200, hermesPreview.text)
    assert.equal(hermesPreview.json().note, EN.settingsAgentSetupConfirm('Hermes Agent', hermesPreview.json().count, true))
    writeFileSync(join(f.home, '.cursor', 'hooks.json'), '{"hooks":false}')
    const failed = await board.call('POST', '/api/agents/setup', { agent: 'cursor' })
    assert.equal(failed.status, 409)
    assert.equal(failed.json().note, EN.setupErrorConflict('Cursor'))
    assert.equal(row(await getRows(), 'cursor').state, EN.settingsAgentNotSetUp)
    for (const agent of [null, 7, {}, '../../cursor', '__proto__', 'cursor,codex']) {
      for (const action of ['setup', 'remove']) assert.equal((await board.call('POST', '/api/agents/' + action, { agent })).status, 400)
    }
    const claude = await board.call('POST', '/api/agents/remove', { agent: 'claude' })
    assert.equal(claude.status, 409)
    assert.match(claude.json().note, /Close the board.*claude plugin uninstall/)
    assert.equal((await board.call('GET', '/api/agents', undefined, { 'x-board-token': 'wrong' })).status, 403)
    assert.equal((await board.call('POST', '/api/agents/setup', { agent: 'cursor' }, { origin: 'https://example.invalid' })).status, 403)
    const opened = await board.call('POST', '/api/lan', { address: '192.168.42.2' })
    assert.equal(opened.status, 200, opened.text)
    const phone = new URL(opened.json().url)
    const phoneRows = await transport(phone, 'GET', '/api/agents')
    assert.equal(phoneRows.status, 200)
    assert.ok(phoneRows.json().rows.every(one => one.button === null && one.note === undefined))
    for (const action of ['setup', 'remove']) {
      const denied = await transport(phone, 'POST', '/api/agents/' + action, { agent: 'cursor' })
      assert.equal(denied.status, 403)
      assert.deepEqual(denied.json(), {})
    }
    const phonePage = await transport(phone, 'GET', '/?t=' + phone.searchParams.get('t'))
    assert.equal(phonePage.status, 200)
    const panel = phonePage.text.match(/<div id="settings"[\s\S]*?(?=<script type="application\/json")/)[0]
    assert.ok(panel.includes('settings-agent-list'))
    assert.doesNotMatch(panel, /settings-agent-(yes|cancel)|aria-label="(?:Set up|Remove) /)
  } finally { await board.close() }
})

test('Settings setup and removal match terminal setup byte for byte and refuse the last running board without removing history', { timeout: 25_000 }, async () => {
  const f = fixture()
  mkdirSync(join(f.home, '.cursor'))
  f.setup('--agent', 'gemini', '--apply')
  const history = join(f.data, 'progress-archive-2026-01.md')
  writeFileSync(history, '# Synthetic history\n')
  const baseline = join(f.root, 'baseline')
  cpSync(f.home, baseline, { recursive: true })
  let afterSetup
  let afterRemove
  const board = await f.start()
  try {
    const beforePreview = files(f.home)
    const preview = await board.call('GET', '/api/agents?agent=cursor&action=setup')
    assert.equal(preview.status, 200, preview.text)
    assert.ok(preview.json().count > 0)
    assert.match(preview.json().note, new RegExp('change ' + preview.json().count + ' files'))
    assert.equal(preview.json().note, EN.settingsAgentSetupConfirm('Cursor', preview.json().count, false))
    assert.deepEqual(files(f.home), beforePreview, 'the preview writes nothing')
    const added = await board.call('POST', '/api/agents/setup', { agent: 'cursor' })
    assert.equal(added.status, 200, added.text)
    const alreadySetUp = await board.call('GET', '/api/agents?agent=cursor&action=setup')
    assert.equal(alreadySetUp.status, 200, alreadySetUp.text)
    assert.equal(alreadySetUp.json().count, 0)
    assert.equal(alreadySetUp.json().note, EN.settingsAgentSetupConfirm('Cursor', 0, false))
    afterSetup = files(f.home)
    const removed = await board.call('POST', '/api/agents/remove', { agent: 'cursor' })
    assert.equal(removed.status, 200, removed.text)
    afterRemove = files(f.home)
    assert.equal(readFileSync(history, 'utf8'), '# Synthetic history\n')
    const rows = (await board.call('GET', '/api/agents')).json().rows
    assert.equal(rows.find(row => row.agent === 'cursor').state, EN.settingsAgentNotSetUp)
    for (const request of [() => board.call('GET', '/api/agents?agent=gemini&action=remove'), () => board.call('POST', '/api/agents/remove', { agent: 'gemini' })]) {
      const refused = await request()
      assert.equal(refused.status, 409, refused.text)
      assert.match(refused.json().note, /Close the board.*--codex-remove/)
      assert.ok(refused.json().note.includes('gemini'))
      assert.deepEqual(files(f.home), afterRemove, 'a last-agent refusal changes no file')
    }
    assert.ok(existsSync(join(f.data, 'agent-board.mjs')))
  } finally { await board.close() }
  // Twin homes use identical logical paths, so absolute commands and ownership hashes compare exactly.
  renameSync(f.home, join(f.root, 'page-home'))
  cpSync(baseline, f.home, { recursive: true })
  f.setup('--agent', 'cursor', '--apply')
  assert.deepEqual(files(f.home), afterSetup, 'page setup and setup --agent cursor --apply write identical file lists and bytes')
  f.local('--codex-remove', '--agent', 'cursor', '--apply')
  assert.deepEqual(files(f.home), afterRemove, 'page removal and --codex-remove --agent cursor --apply leave identical files and bytes')
  assert.equal(readFileSync(history, 'utf8'), '# Synthetic history\n')
  assert.ok(existsSync(f.progress))
})

const settingsDom = (isLan, answer, words = EN) => {
  const nodes = new Map()
  let active = null
  class Element {
    constructor(tag, id) { this.tag = tag; this.attributes = {}; this.children = []; this.events = {}; this.hidden = false; this.disabled = false; if (id) { this.id = id; nodes.set(id, this) } }
    set textContent(value) { this.text = String(value); this.children = [] }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join('') }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child }
    setAttribute(key, value) { this.attributes[key] = String(value) }
    getAttribute(key) { return this.attributes[key] ?? null }
    addEventListener(name, callback) { this.events[name] = callback }
    focus() { active = this }
    click() { if (!this.disabled) this.events.click?.({ target: this }) }
    closest() { for (let one = this; one; one = one.parentNode) if (one.hidden) return one; return null }
    querySelectorAll(selector) { return this.children.flatMap(child => [...((selector === 'button, select' ? ['button', 'select'].includes(child.tag) : child.tag === selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  }
  const make = (tag, id, parent) => { const node = new Element(tag, id); parent?.appendChild(node); return node }
  const panel = make('div', 'settings')
  panel.hidden = true
  panel.setAttribute('data-lan', String(isLan))
  for (const [tag, id] of [['button', 'settings-close'], ['select', 'settings-lang'], ['div', 'settings-notifications'], ['ul', 'settings-agent-list'], ['p', 'settings-result']]) make(tag, id, panel)
  make('button', 'settings-notify', nodes.get('settings-notifications'))
  if (!isLan) {
    const confirm = make('div', 'settings-agent-confirm', panel)
    confirm.hidden = true
    for (const [tag, id] of [['p', 'settings-agent-question'], ['button', 'settings-agent-yes'], ['button', 'settings-agent-cancel']]) make(tag, id, confirm)
  }
  make('div', 'shell')
  make('button', 'settings-toggle')
  const requests = []
  const keyEvents = {}
  const pending = new Set()
  const document = {
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => new Element(tag),
    querySelectorAll: () => [],
    addEventListener: (name, callback) => { keyEvents[name] = callback },
    get activeElement() { return active },
  }
  runInNewContext(settingsScript, {
    document, window: { isSecureContext: false }, encodeURIComponent,
    w: key => words[key], agentName: agent => words.agentNames[agent],
    call: (path, body) => {
      requests.push({ path, body })
      const promise = Promise.resolve().then(() => answer(path, body))
      pending.add(promise)
      promise.then(() => pending.delete(promise), () => pending.delete(promise))
      return promise
    },
  }, { timeout: 1000 })
  const settle = async () => { do { await Promise.allSettled([...pending]); await new Promise(done => setImmediate(done)) } while (pending.size) }
  return { node: id => nodes.get(id), active: () => active, requests, settle, key: event => keyEvents.keydown(event) }
}

test('Settings previews before confirming, restores keyboard focus, displays the result and refreshes actual rows after success and failure', async () => {
  let isSetUp = false
  let isFailing = false
  const dom = settingsDom(false, (path, body) => {
    if (path === '/api/agents') return { ok: true, rows: [{ agent: 'cursor', name: 'Cursor', state: isSetUp ? EN.settingsAgentStart : EN.settingsAgentNotSetUp, button: isSetUp ? 'remove' : 'setup' }] }
    if (path.startsWith('/api/agents?')) return { ok: true, count: 7, note: isSetUp ? EN.settingsAgentRemoveConfirm('Cursor') : EN.settingsAgentSetupConfirm('Cursor', 7, false) }
    assert.deepEqual(JSON.parse(JSON.stringify(body)), { agent: 'cursor' })
    if (isFailing) return { ok: false, note: 'Synthetic setup refusal' }
    isSetUp = !isSetUp
    return { ok: true, note: EN.settingsAgentSetupDone('Cursor') }
  })
  dom.node('settings-toggle').click()
  await dom.settle()
  let button = dom.node('settings-agent-list').querySelectorAll('button')[0]
  assert.equal(button.getAttribute('aria-label'), 'Set up Cursor')
  button.click()
  await dom.settle()
  assert.equal(dom.node('settings-agent-confirm').hidden, false)
  assert.equal(dom.active(), dom.node('settings-agent-yes'))
  assert.match(dom.node('settings-agent-question').textContent, /7 files/)
  assert.ok(dom.requests.every(one => one.body === undefined))
  dom.node('settings-agent-cancel').click()
  assert.equal(dom.active(), button)
  assert.equal(dom.node('settings-agent-confirm').hidden, true)
  button.click()
  await dom.settle()
  dom.node('settings-close').focus()
  let prevented = false
  dom.key({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(dom.active(), dom.node('settings-agent-cancel'))
  dom.node('settings-agent-yes').click()
  await dom.settle()
  assert.equal(dom.node('settings-result').textContent, EN.settingsAgentSetupDone('Cursor'))
  assert.equal(dom.node('settings-result').className, '')
  assert.match(dom.node('settings-agent-list').textContent, /Open a new session/)
  button = dom.node('settings-agent-list').querySelectorAll('button')[0]
  assert.equal(button.getAttribute('aria-label'), 'Remove Cursor')
  assert.equal(dom.active(), button)
  isFailing = true
  button.click()
  await dom.settle()
  dom.node('settings-agent-yes').click()
  await dom.settle()
  assert.equal(dom.node('settings-result').textContent, 'Synthetic setup refusal')
  assert.equal(dom.node('settings-result').className, 'alert')
  assert.equal(dom.node('settings-agent-list').querySelectorAll('button')[0].getAttribute('aria-label'), 'Remove Cursor')
  assert.equal(dom.requests.filter(one => one.path === '/api/agents').length, 3)
})

test('Settings keeps phone agent rows read only and uses wrapping lists with 48 pixel controls at 375 pixels', async () => {
  for (const words of [EN, ZH_TW, ZH_CN]) {
    const html = settingsPanel(words, 'en', true)
    assert.match(html, /<ul id="settings-agent-list" aria-labelledby="settings-agents-title">/)
    assert.doesNotMatch(html, /settings-agent-(yes|cancel)/)
    assert.ok(html.includes(words.settingsAgents))
    const dom = settingsDom(true, () => ({ ok: true, rows: [
      { agent: 'cursor', name: 'Cursor', state: words.settingsAgentNotSetUp, button: 'setup' },
      { agent: 'codex', name: 'Codex', state: words.settingsAgentOnBoard, button: 'remove' },
    ] }), words)
    dom.node('settings-toggle').click()
    await dom.settle()
    assert.equal(dom.node('settings-agent-list').children.length, 2)
    assert.equal(dom.node('settings-agent-list').querySelectorAll('button').length, 0)
  }
  assert.match(settingsCss, /min-width:48px;min-height:48px;max-width:100%/)
  assert.match(settingsCss, /grid-template-columns:minmax\(0,1fr\) auto/)
  assert.match(settingsCss, /overflow-wrap:anywhere/)
})

// A held settings lock: the local page names its full path, a phone on the network only its file name
// (the page's path-privacy rule; codex_166 finding 6). The held lock stays as it was.
test('a held settings lock names its full path on the local page and only its file name on the network page (#1276)', { timeout: 30_000 }, async () => {
  const f = fixture(true)
  const lock = join(f.data, 'progress-settings.json.agent-board.lock')
  writeFileSync(lock, 'synthetic held lock\n')
  const board = await f.start()
  try {
    const local = await board.call('POST', '/api/style', { style: 'blue' })
    assert.equal(local.status, 409, local.text)
    assert.equal(local.json().note, EN.settingsLocked(lock))
    const opened = await board.call('POST', '/api/lan', { address: '192.168.42.2' })
    assert.equal(opened.status, 200, opened.text)
    const phone = await transport(new URL(opened.json().url), 'POST', '/api/style', { style: 'blue' })
    assert.equal(phone.status, 409, phone.text)
    assert.equal(phone.json().note, EN.settingsLocked('progress-settings.json.agent-board.lock'))
    assert.ok(!phone.text.includes(f.data), 'the network page never shows the data folder')
    assert.equal(readFileSync(lock, 'utf8'), 'synthetic held lock\n')
  } finally { await board.close() }
})

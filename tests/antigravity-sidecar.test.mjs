import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ANTIGRAVITY_WAKE_LINE, antigravitySidecarConfig, antigravitySidecarSource } from '../hooks/antigravity-sidecar.ts'
import { defaultMessagesDirectory } from '../scripts/runtime-folder.ts'

// The sidecar runs here as the real script, against a stand-in board (a local http server plus the
// server.lock / server.owner files a board keeps) and a stand-in for Antigravity's `agentapi`, which
// logs its arguments. Nothing here calls Antigravity, and every id and token is synthetic.
const TOKEN = 'tok-SECRETvalue-9f3a'
const UUID = '0b6d6e0e-6f43-4c0b-9a58-3f1a7e3a1c11'

const preload = `const path = require('node:path'), fs = require('node:fs')
if (path.basename(process.argv[1] ?? '') === 'agentapi') {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
  if (process.env.FAKE_HANG === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
  else process.exit(Number(process.env.FAKE_EXIT ?? 0))
}
`

const fixture = async ({ answer, board = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-sidecar-'))
  const folder = join(dir, 'messages')
  mkdirSync(folder)
  const requests = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const body = JSON.parse(text || '{}')
      const action = req.url.replace('/api/messages/', '').split('?')[0]
      requests.push({ action, token: req.headers['x-board-token'], body })
      const [status, result] = answer(action, body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  })
  if (board) {
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    writeFileSync(join(folder, 'server.lock'), String(process.pid))
    writeFileSync(join(folder, 'server.owner'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}/?t=${TOKEN}` }))
  }
  writeFileSync(join(dir, 'sidecar.mjs'), antigravitySidecarSource())
  writeFileSync(join(dir, 'preload.cjs'), preload)
  const log = join(dir, 'agentapi.log')
  const run = (extra = [], env = {}) => new Promise(done => {
    const child = spawn(process.execPath, [join(dir, 'sidecar.mjs'), '--messages-dir', folder, '--once', ...extra], {
      cwd: dir, windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: `--require=${join(dir, 'preload.cjs')}`, ANTIGRAVITY_AGENTAPI_EXE: process.execPath, FAKE_LOG: log, ...env },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('exit', code => done({ code, output }))
  })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const close = () => { server.close(); rmSync(dir, { recursive: true, force: true }) }
  return { dir, folder, requests, run, calls, close }
}
const wakeAnswer = wakes => (action, body) => action === 'wake-poll' ? [200, { wakes }] : action === 'wake-report' ? [200, { ok: true }] : [404, { error: 'UNKNOWN_ACTION' }]

test('a wake owed for a conversation sends the one fixed line and reports sent', async () => {
  const f = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }]) })
  try {
    const result = await f.run()
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.calls(), [['send-message', '--title=Agent Board', UUID, ANTIGRAVITY_WAKE_LINE]])
    assert.deepEqual(f.requests.map(one => one.action), ['wake-poll', 'wake-report'])
    assert.deepEqual(f.requests[0].body, { agent: 'antigravity' })
    assert.deepEqual(f.requests[1].body, { id: 'w1', nonce: 'n1', status: 'sent' })
    assert.ok(f.requests.every(one => one.token === TOKEN), 'every call carries the board token header')
  } finally { f.close() }
})

test('a conversation that is not a UUID is refused: nothing is run and the wake is reported failed', async () => {
  const f = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: 'x; rm -rf /', nonce: 'n1' }, { id: 'w2', conversation: '--title=evil', nonce: 'n2' }]) })
  try {
    const result = await f.run()
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.calls(), [])
    const reports = f.requests.filter(one => one.action === 'wake-report').map(one => one.body)
    assert.deepEqual(reports, [{ id: 'w1', nonce: 'n1', status: 'failed', error: 'INVALID_CONVERSATION' }, { id: 'w2', nonce: 'n2', status: 'failed', error: 'INVALID_CONVERSATION' }])
  } finally { f.close() }
})

test('a failed or hung agentapi is reported failed with a short code, never as sent', async () => {
  const failing = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }]) })
  try {
    await failing.run([], { FAKE_EXIT: '3' })
    assert.deepEqual(failing.requests.at(-1).body, { id: 'w1', nonce: 'n1', status: 'failed', error: 'EXIT_3' })
  } finally { failing.close() }
  const hung = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }]) })
  try {
    await hung.run(['--send-timeout-ms', '400'], { FAKE_HANG: '1' })
    assert.deepEqual(hung.requests.at(-1).body, { id: 'w1', nonce: 'n1', status: 'failed', error: 'TIMEOUT' })
  } finally { hung.close() }
})

test('with no board running the sidecar makes no request and runs nothing', async () => {
  const f = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }]), board: false })
  try {
    const result = await f.run()
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.requests, [])
    assert.deepEqual(f.calls(), [])
  } finally { f.close() }
})

test('an error answer to wake-poll (a board without the wake route) is no wakes: nothing is run or reported', async () => {
  const f = await fixture({ answer: () => [400, { error: 'UNKNOWN_ACTION', wakes: [{ id: 'w1', conversation: UUID, nonce: 'n1' }] }] })
  try {
    const result = await f.run()
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.requests.map(one => one.action), ['wake-poll'])
    assert.deepEqual(f.calls(), [])
  } finally { f.close() }
})

test('without Antigravity\'s agentapi path the sidecar does not even poll', async () => {
  const f = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }]) })
  try {
    const result = await f.run([], { ANTIGRAVITY_AGENTAPI_EXE: '' })
    assert.equal(result.code, 0, result.output)
    assert.deepEqual(f.requests, [])
  } finally { f.close() }
})

test('the folder it looks in is the one the board and its hooks use', async () => {
  const f = await fixture({ answer: wakeAnswer([]), board: false })
  try {
    const progress = join(f.dir, 'progress.md')
    const runtime = join(f.dir, 'runtime')
    mkdirSync(runtime, { mode: 0o700 })
    for (const runtimeDir of [undefined, runtime]) {
      const env = { ...process.env }
      if (runtimeDir === undefined) delete env.XDG_RUNTIME_DIR; else env.XDG_RUNTIME_DIR = runtimeDir
      const printed = await new Promise(done => {
        const child = spawn(process.execPath, [join(f.dir, 'sidecar.mjs'), '--progress-file', progress, '--home', f.dir, '--print-folder'], { env, windowsHide: true })
        let output = ''
        child.stdout.on('data', chunk => { output += chunk })
        child.on('exit', () => done(output.trim()))
      })
      assert.equal(printed, defaultMessagesDirectory(progress, f.dir, env, process.platform))
    }
  } finally { f.close() }
})

test('the board token never appears in sidecar.json, in the arguments to agentapi, or in anything the sidecar prints', async () => {
  const f = await fixture({ answer: wakeAnswer([{ id: 'w1', conversation: UUID, nonce: 'n1' }, { id: 'w2', conversation: 'bad', nonce: 'n2' }]) })
  try {
    const config = antigravitySidecarConfig(process.execPath, join(f.dir, 'progress.md'), f.dir)
    const result = await f.run([], { FAKE_EXIT: '2' })
    assert.ok(f.requests.length > 0 && f.requests.every(one => one.token === TOKEN))
    for (const [name, text] of [['sidecar.json', config], ['agentapi arguments', JSON.stringify(f.calls())], ['output', result.output], ['sidecar source', antigravitySidecarSource()]]) {
      assert.ok(!text.includes(TOKEN), `${name} holds the board token`)
    }
    assert.ok(f.calls().length > 0, 'the run reached agentapi')
  } finally { f.close() }
})

test('sidecar.json only names the files setup wrote: node, sidecar.mjs, the progress file and home, restart always, never enabled', () => {
  const config = JSON.parse(antigravitySidecarConfig('/node', '/p/progress.md', '/home/a'))
  assert.deepEqual(config.args, ['sidecar.mjs', '--progress-file', '/p/progress.md', '--home', '/home/a'])
  assert.equal(config.command, '/node')
  assert.equal(config.restart_policy, 'always')
  assert.ok(!('enabled' in config))
})

test('the poll interval is 2 s while a board answers and 30 s otherwise', () => {
  const source = antigravitySidecarSource()
  assert.match(source, /const FAST_MS = 2000\n/)
  assert.match(source, /const SLOW_MS = 30000\n/)
})

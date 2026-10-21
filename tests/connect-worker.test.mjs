import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONNECT_BOOTSTRAP, CONNECT_EXECUTE, workerRequest, workerStage } from '../hooks/connect-worker.ts'

const run = (code, args, esm = false) => spawnSync(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', code, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
const stage = code => {
  const digest = createHash('sha256').update(code).digest('hex')
  const created = run(CONNECT_BOOTSTRAP, [digest])
  assert.equal(created.status, 0, created.stderr)
  const value = workerStage(JSON.parse(created.stdout), digest)
  assert.ok(value)
  return { digest, value }
}

test('the native worker bootstrap executes verified code with short metadata and cleans only its owned stage', () => {
  const code = `process.stdout.write(JSON.stringify({ source: typeof globalThis.AGENT_BOARD_WORKER_SOURCE === 'string', request: JSON.parse(process.argv[3]) }))`
  const { digest, value } = stage(code)
  try {
    writeFileSync(value.file, code)
    const result = run(CONNECT_EXECUTE, [digest, JSON.stringify(value), workerRequest({ mode: 'status', home: '/synthetic', progress: '/synthetic/progress.md', lang: 'en', node: process.version })], true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).request.mode, 'status')
    assert.equal(JSON.parse(result.stdout).source, true)
    assert.equal(existsSync(value.directory), false)
  } finally { if (existsSync(value.directory)) rmSync(value.directory, { recursive: true, force: true }) }
})

test('the native worker bootstrap refuses changed code and unknown stage ownership before execution', () => {
  const code = 'process.stdout.write("MUST_NOT_RUN")'
  for (const change of ['code', 'owner']) {
    const { digest, value } = stage(code)
    try {
      writeFileSync(value.file, change === 'code' ? `${code}\n// changed` : code)
      if (change === 'owner') writeFileSync(value.directory + '/.owner', 'foreign-token')
      const result = run(CONNECT_EXECUTE, [digest, JSON.stringify(value), '{}'], true)
      assert.notEqual(result.status, 0)
      assert.ok(!result.stdout.includes('MUST_NOT_RUN'))
      assert.ok(existsSync(value.directory))
      assert.ok(result.stderr.includes(change === 'code' ? 'WORKER_DIGEST_CHANGED' : 'WORKER_OWNERSHIP_LOST'))
    } finally { rmSync(value.directory, { recursive: true, force: true }) }
  }
})

test('worker transport accepts generated ownership hashes and refuses configuration bodies and oversized argv plans', () => {
  const request = { mode: 'connect', home: '/synthetic', progress: '/synthetic/progress.md', lang: 'en', node: process.version }
  assert.ok(workerRequest({ ...request, seed: { owned: { '/synthetic/board.mjs': 'a'.repeat(64) }, disabled: true } }))
  assert.equal(workerRequest({ ...request, config: { private: 'MUST_NOT_STAGE' } }), null)
  assert.equal(workerRequest({ ...request, seed: { owned: { '/synthetic/hooks.json': '{"private":"MUST_NOT_STAGE"}' } } }), null)
  assert.equal(workerRequest({ ...request, progress: 'x'.repeat(12001) }), null)
  assert.equal(workerStage({ protocol: 1, directory: '/tmp/agent-board-worker-x', file: '/foreign.mjs', token: 'a'.repeat(32) }, 'b'.repeat(64)), null)
})

test('a large verified module reports a bounded failure without embedding its data URL', () => {
  const code = '// ' + 'synthetic padding '.repeat(24000) + '\nthrow new Error("SYNTHETIC_NATIVE_FAILURE")'
  const { digest, value } = stage(code)
  try {
    writeFileSync(value.file, code)
    const result = run(CONNECT_EXECUTE, [digest, JSON.stringify(value), workerRequest({ mode: 'status', home: value.directory, progress: value.directory + '/progress.md', lang: 'en', node: process.version })], true)
    assert.notEqual(result.status, 0)
    assert.ok(Buffer.byteLength(result.stderr) < 256, 'native execution failure must not print the verified module data URL')
    assert.equal(result.stderr.trim(), 'SYNTHETIC_NATIVE_FAILURE')
    assert.equal(existsSync(value.directory), false)
  } finally { if (existsSync(value.directory)) rmSync(value.directory, { recursive: true, force: true }) }
})

test('the full generated worker bundle runs through verified staging without recursive bundle growth', () => {
  const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
  const code = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length))
  // The cap only guards against the bundle containing itself, which roughly doubles its size.
  // A 750,000-character cap still catches that. Each board-cli pull request adds about 5 KB,
  // so a tighter cap fails on ordinary growth.
  assert.ok(code.length < 750000)
  assert.ok(!code.includes('BOARD_SCRIPT'), 'the worker bundle embeds no earlier board bundle')
  const { digest, value } = stage(code)
  try {
    writeFileSync(value.file, code)
    const request = { mode: 'remove', home: value.directory, progress: value.directory + '/progress.md', lang: 'en', node: null }
    const result = run(CONNECT_EXECUTE, [digest, JSON.stringify(value), workerRequest(request)], true)
    assert.notEqual(result.status, 0)
    assert.ok((result.stderr + result.stdout).includes('NODE_REQUIRED'))
    assert.equal(existsSync(value.directory), false)
  } finally { if (existsSync(value.directory)) rmSync(value.directory, { recursive: true, force: true }) }
})

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
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

test('the generated bundle is stored one line per line so pull requests that change different code merge cleanly', () => {
  const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
  // A Windows checkout may turn each line ending into CRLF; the array reads the same either way.
  const lines = source.split(/\r?\n/)
  assert.ok(lines.length > 1000)
  assert.equal(lines[1], 'export const BOARD_SCRIPT = [')
  assert.equal(lines.at(-2), "].join('\\n')")
  const encoded = lines.slice(2, -2)
  const decoded = encoded.map((line, index) => {
    if (index < encoded.length - 1) assert.ok(line.endsWith(','))
    const literal = index < encoded.length - 1 ? line.slice(0, -1) : line
    const value = JSON.parse(literal)
    assert.equal(typeof value, 'string')
    assert.equal(JSON.stringify(value), literal)
    assert.ok(!value.includes('\n'))
    return value
  })
  assert.equal(decoded.join('\n'), BOARD_SCRIPT)
})

test('the full generated worker bundle runs through verified staging without recursive bundle growth', () => {
  const source = readFileSync(new URL('../hooks/board-script.ts', import.meta.url), 'utf8')
  const code = JSON.parse(source.slice(source.indexOf('export const BOARD_SCRIPT = ') + 'export const BOARD_SCRIPT = '.length, source.lastIndexOf(']') + 1)).join('\n')
  assert.ok(code.includes('// hooks/connect-pure.ts'))
  assert.ok(code.includes('// scripts/legacy-connect.ts'))
  assert.ok(!code.includes('// hooks/board-script.ts'))
  assert.ok(!code.includes('// hooks/connect.ts'))
  assert.ok(!/\b(?:var|let|const) BOARD_SCRIPT\b/.test(code))
  // One dispatch runs the trusted worker source; the run's error handler only checks that it is set.
  assert.equal(code.split('const trusted = globalThis.AGENT_BOARD_WORKER_SOURCE').length - 1, 1)
  // Staged code has no argv size limit. This is only a coarse growth alarm;
  // the structural checks above catch an embedded generated predecessor.
  assert.ok(Buffer.byteLength(code) < 1024 * 1024)
  // A bundle built twice into itself repeats every module banner, so each hooks/ module appears once.
  // An earlier build embedded as a string keeps its banners inside the string: the BOARD_SCRIPT
  // checks and the byte cap catch that. A character cap was only a guess, and ordinary growth reached it.
  const modules = code.match(/^\/\/ hooks\/[\w./-]+\.tsx?$/gm) ?? []
  assert.ok(modules.length > 20, 'the worker bundle carries its hooks/ module banners')
  assert.equal(new Set(modules).size, modules.length, 'each hooks/ module appears once in the worker bundle')
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

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { CONNECT_BOOTSTRAP, CONNECT_EXECUTE, workerRequest, workerStage } from '../hooks/connect-worker.ts'
import { RELEASED } from '../hooks/released.ts'
import { bundleCode, bundleFiles, bundleFromDir, bundleFromRef, bundleParts, readBundle } from '../scripts/bundle-text.mjs'
import { MAX_MODULE, bundleModules, crlfSize, moduleBudget, splitBundle } from '../scripts/bundle-parts.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const readText = path => readFileSync(join(repo, path), 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
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

// A Windows checkout may turn each line ending into CRLF; the array reads the same either way.
const linesOf = text => text.split(/\r?\n/)
// One bundle part: its comment, the `export const LINES = [` frame, one JSON string per bundle line, `]`, and a final newline.
// Returns the decoded lines.
const partStrings = (path, number) => {
  const lines = linesOf(readText(path))
  assert.equal(lines[0], `// Generated by scripts/build-board.ts: part ${number} of the board bundle; do not edit by hand.`)
  assert.equal(lines[1], 'export const LINES = [')
  assert.deepEqual(lines.slice(-2), [']', ''])
  const encoded = lines.slice(2, -2)
  assert.ok(encoded.length > 100, `${path} holds the bundle lines`)
  return encoded.map((line, index) => {
    if (index < encoded.length - 1) assert.ok(line.endsWith(','))
    const literal = index < encoded.length - 1 ? line.slice(0, -1) : line
    const value = JSON.parse(literal)
    assert.equal(typeof value, 'string')
    assert.equal(JSON.stringify(value), literal)
    assert.ok(!value.includes('\n'))
    return value
  })
}
const entryPath = 'hooks/board-script.ts'
const partNames = () => bundleParts(readText(entryPath))

test('the generated bundle is stored one line per line so pull requests that change different code merge cleanly', () => {
  const parts = partNames()
  assert.ok(parts.length >= 2, 'the bundle is kept in at least two parts')
  assert.deepEqual(parts, parts.map((_, index) => `hooks/board-script-${index + 1}.ts`))
  const decoded = parts.flatMap((path, index) => partStrings(path, index + 1))
  assert.ok(decoded.length > 1000)
  assert.equal(decoded.join('\n'), BOARD_SCRIPT)
  assert.equal(readBundle(readText), BOARD_SCRIPT)
})

test('the bundle parts decode to the same BOARD_SCRIPT, byte for byte, as the bundle before the split', async t => {
  const parts = partNames()
  // The entry holds only its two comments, one import per part and the BOARD_SCRIPT line, so Claude Code reads it at once.
  assert.deepEqual(linesOf(readText(entryPath)), [
    '// Generated by scripts/build-board.ts from scripts/board-cli.ts; do not edit by hand.',
    "// Kept in parts so each module stays under Claude Code's 1 MiB module limit (#582).",
    ...parts.map((path, index) => `import { LINES as PART_${index + 1} } from './${path.slice('hooks/'.length)}'`),
    `export const BOARD_SCRIPT = [${parts.map((_, index) => `...PART_${index + 1}`).join(', ')}].join('\\n')`,
    '',
  ])
  const decoded = parts.flatMap((path, index) => partStrings(path, index + 1)).join('\n')
  assert.equal(decoded, BOARD_SCRIPT)
  assert.equal(bundleFromDir(repo), BOARD_SCRIPT)
  assert.equal(bundleFromDir(new URL('..', import.meta.url)), BOARD_SCRIPT)
  // Against the bundle this branch started from. After the split has landed on main there is no earlier bundle to compare with.
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  const base = (() => {
    if (git('rev-parse', '--is-shallow-repository').stdout.trim() !== 'false') return { reason: 'git history is shallow or unreadable, so there is no merge base to compare with' }
    for (const ref of ['origin/main', 'main']) {
      const found = git('merge-base', 'HEAD', ref)
      if (found.status !== 0) continue
      const mergeBase = found.stdout.trim()
      const entry = git('show', `${mergeBase}:${entryPath}`)
      if (entry.status !== 0) return { reason: `${entryPath} is not readable at the merge base ${mergeBase.slice(0, 7)}` }
      if (bundleParts(entry.stdout).length) return { reason: `the merge base ${mergeBase.slice(0, 7)} already holds the bundle in parts` }
      return { mergeBase }
    }
    return { reason: 'there is no main branch to find a merge base with' }
  })()
  await t.test('the decoded text is the one the merge base held', { skip: base.reason }, () => {
    assert.equal(sha(BOARD_SCRIPT), sha(bundleFromRef(repo, base.mergeBase)))
  })
})

test("every generated board module stays under Claude Code's module limit counting CRLF line endings", () => {
  const files = bundleFiles(repo)
  assert.ok(files.length >= 3, 'the entry and its parts are listed')
  for (const path of files) {
    // A checkout with CRLF endings holds each line break as two bytes; count it the way the LF text would be.
    const lf = readText(path).replace(/\r\n/g, '\n')
    const bytes = Buffer.byteLength(lf) + (lf.match(/\n/g) ?? []).length
    assert.ok(bytes <= MAX_MODULE, `${path} is ${bytes} bytes with CRLF line endings; the build stops at ${MAX_MODULE}`)
    assert.equal(crlfSize(lf), bytes)
  }
})

test('the build refuses a bundle part over 1,000,000 bytes and names the file, its size and how to add a split point', () => {
  // Built in memory: no 1 MB fixture in git.
  const line = `${'x'.repeat(99)}\n`
  const files = {
    'hooks/board-script.ts': 'export const BOARD_SCRIPT = 1\n',
    'hooks/board-script-1.ts': 'x'.repeat(1_000_000),
    // Under the limit as LF text, over it once each of its 9,999 line breaks takes two bytes.
    'hooks/board-script-2.ts': line.repeat(9_999),
  }
  const { problems, notes } = moduleBudget(files)
  assert.equal(problems.length, 1)
  assert.equal(problems[0], 'hooks/board-script-2.ts would be 1,009,899 bytes (with CRLF line endings); Claude Code does not load a plugin module over 1,048,576 bytes, and this build stops at 1,000,000. Add a split point: put a module banner line near the middle of that part (for example "// hooks/serve.ts") in PART_STARTS in scripts/build-board.ts, rebuild, and list the new part in package.json "files".')
  assert.deepEqual(notes, ['hooks/board-script-1.ts is 1,000,000 of 1,000,000 bytes; add a split point soon'])
  const sizes = Object.fromEntries(moduleBudget(files).sizes.map(size => [size.path, size]))
  assert.deepEqual(sizes['hooks/board-script-2.ts'], { path: 'hooks/board-script-2.ts', lf: 999_900, crlf: 1_009_899 })
  // One byte over the stop is refused; the stop itself and a part well under it are not.
  assert.equal(moduleBudget({ 'hooks/board-script-1.ts': 'x'.repeat(1_000_001) }).problems.length, 1)
  assert.deepEqual(moduleBudget({ 'hooks/board-script-1.ts': 'x'.repeat(1_000_000) }).problems, [])
  assert.deepEqual(moduleBudget({ 'hooks/board-script-1.ts': 'x'.repeat(850_000) }), { sizes: [{ path: 'hooks/board-script-1.ts', lf: 850_000, crlf: 850_000 }], problems: [], notes: [] })
})

test('a split point that is not exactly one bundle line stops the build with a plain message', () => {
  const code = ['// scripts/board-cli.ts', 'a', '// hooks/one.ts', 'b', '// scripts/board-cli.ts', 'c', '// hooks/two.ts', 'd', ''].join('\n')
  const plain = point => new RegExp(`split point "${point.replace(/[./]/g, '\\$&')}" is not a line of the bundle \\(or appears twice\\): pick another module banner for PART_STARTS in scripts/build-board\\.ts$`)
  // A banner Bun repeats, a line that is not there and a part of a line are all refused.
  for (const point of ['// scripts/board-cli.ts', '// hooks/three.ts', 'hooks/one.ts']) assert.throws(() => splitBundle(code, [point]), plain(point))
  assert.throws(() => splitBundle(code, ['// hooks/two.ts', '// hooks/one.ts']), /split points are out of order: "\/\/ hooks\/one\.ts" comes before "\/\/ hooks\/two\.ts"/)
  assert.throws(() => splitBundle('// hooks/one.ts\nb', ['// hooks/one.ts']), /would leave part 1 empty/)
  // Exact lines split where they stand, and the parts join back to the bundle.
  const parts = splitBundle(code, ['// hooks/one.ts', '// hooks/two.ts'])
  assert.deepEqual(parts.map(part => part[0]), ['// scripts/board-cli.ts', '// hooks/one.ts', '// hooks/two.ts'])
  assert.equal(parts.flat().join('\n'), code)
  assert.deepEqual(Object.keys(bundleModules(code, ['// hooks/one.ts', '// hooks/two.ts'])), ['hooks/board-script.ts', 'hooks/board-script-1.ts', 'hooks/board-script-2.ts', 'hooks/board-script-3.ts'])
  const modules = bundleModules(code, ['// hooks/one.ts'])
  assert.equal(readBundle(path => modules[path]), code)
})

test('a release tag holds the same bundle whether it is one line, as up to 0.24.0, or one line per line, with LF or CRLF', () => {
  const code = 'import x from "y";\n\nconst s = "a \\\\ b\\r";\u2028 line\n'
  const header = '// Generated by scripts/build-board.ts from scripts/board-cli.ts; do not edit by hand.\n'
  const oneLine = `${header}export const BOARD_SCRIPT = ${JSON.stringify(code)}\n`
  const perLine = `${header}export const BOARD_SCRIPT = [\n${code.split('\n').map(line => JSON.stringify(line)).join(',\n')}\n].join('\\n')\n`
  for (const source of [oneLine, perLine, oneLine.replace(/\n/g, '\r\n'), perLine.replace(/\n/g, '\r\n')]) assert.equal(bundleCode(source), code)
  assert.throws(() => bundleCode(`${header}export const OTHER = 1\n`), /unsupported format/)
})

// The same bundle text in the three forms a checkout or a tag holds, as a map from path to file text.
const formsOf = code => {
  const header = '// Generated by scripts/build-board.ts from scripts/board-cli.ts; do not edit by hand.\n'
  const lines = code.split('\n')
  const part = (number, items) => `// Generated by scripts/build-board.ts: part ${number} of the board bundle; do not edit by hand.\nexport const LINES = [\n${items.map(line => JSON.stringify(line)).join(',\n')}\n]\n`
  return {
    'the one-line form': { 'hooks/board-script.ts': `${header}export const BOARD_SCRIPT = ${JSON.stringify(code)}\n` },
    'the per-line form': { 'hooks/board-script.ts': `${header}export const BOARD_SCRIPT = [\n${lines.map(line => JSON.stringify(line)).join(',\n')}\n].join('\\n')\n` },
    'the parts form': {
      'hooks/board-script.ts': `${header}// Kept in parts so each module stays under Claude Code's 1 MiB module limit (#582).\nimport { LINES as PART_1 } from './board-script-1.ts'\nimport { LINES as PART_2 } from './board-script-2.ts'\nexport const BOARD_SCRIPT = [...PART_1, ...PART_2].join('\\n')\n`,
      'hooks/board-script-1.ts': part(1, lines.slice(0, 2)),
      'hooks/board-script-2.ts': part(2, lines.slice(2)),
    },
  }
}
const readerOf = files => path => {
  if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
  return files[path]
}

test('the bundle reader reads the one-line form, the per-line form and the parts form, with LF and CRLF', () => {
  const code = 'import x from "y";\n\nconst s = "a \\\\ b\\r";\u2028 line\n'
  for (const [form, files] of Object.entries(formsOf(code))) {
    assert.equal(readBundle(readerOf(files)), code, `${form} with LF`)
    const crlf = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(/\n/g, '\r\n')]))
    assert.equal(readBundle(readerOf(crlf)), code, `${form} with CRLF`)
  }
  // The entry of the parts form is not the bundle itself: bundleCode says so instead of decoding something else.
  assert.throws(() => bundleCode(formsOf(code)['the parts form']['hooks/board-script.ts']), /is kept in parts: read it with readBundle/)
  // A part that is missing is the reader's own ENOENT, not an empty bundle.
  const { 'hooks/board-script-2.ts': removed, ...missing } = formsOf(code)['the parts form']
  assert.ok(removed)
  assert.throws(() => readBundle(readerOf(missing)), { code: 'ENOENT' })
  // The release tag that still holds the one-line form decodes to the board script the release table lists for it.
  const tag = 'agent-board--v0.24.0'
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: repo, windowsHide: true, timeout: 30000 }).status === 0
  if (exists) assert.ok(RELEASED.find(release => release.version === '0.24.0').board.includes(sha(bundleFromRef(repo, tag))))
})

test('the bundle reader rejects a part whose items are not all strings', () => {
  const files = formsOf('a\nb\nc\n')['the parts form']
  assert.equal(readBundle(readerOf(files)), 'a\nb\nc\n')
  for (const items of ['"a",\n1', '"a",\nnull', '"a",\n["b"]', '"a",\n{"b": "c"}']) {
    const part = `// Generated by scripts/build-board.ts: part 2 of the board bundle; do not edit by hand.\nexport const LINES = [\n${items}\n]\n`
    assert.throws(() => readBundle(readerOf({ ...files, 'hooks/board-script-2.ts': part })), /unsupported format/, items)
  }
  assert.throws(() => readBundle(readerOf({ ...files, 'hooks/board-script-2.ts': 'export const OTHER = [1]\n' })), /unsupported format/)
})

test('the full generated worker bundle runs through verified staging without recursive bundle growth', () => {
  const code = bundleFromDir(repo)
  assert.ok(code.includes('// hooks/connect-pure.ts'))
  assert.ok(code.includes('// scripts/legacy-connect.ts'))
  assert.ok(!code.includes('// hooks/board-script.ts'))
  assert.ok(!code.includes('// hooks/connect.ts'))
  assert.ok(!/\b(?:var|let|const) BOARD_SCRIPT\b/.test(code))
  // One dispatch runs the trusted worker source; the run's error handler only checks that it is set.
  assert.equal(code.split('const trusted = globalThis.AGENT_BOARD_WORKER_SOURCE').length - 1, 1)
  // Staged code has no argv size limit. This is only a coarse growth alarm;
  // the structural checks above catch an embedded generated predecessor. The decoded text is
  // not one module: Claude Code's per-file limit is checked by the module limit test above.
  assert.ok(Buffer.byteLength(code) < 2 * 1024 * 1024)
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

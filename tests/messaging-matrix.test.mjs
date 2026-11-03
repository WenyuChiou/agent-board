import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matrixFiles, readReceiverRecords, receiverRows, renderMatrix } from '../scripts/messaging-matrix.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const start = '<!-- messaging-matrix:start -->'
const end = '<!-- messaging-matrix:end -->'
const connectors = ['codex-message-connector.mjs', 'codex-session-connector.mjs', 'antigravity-session-connector.mjs']
const read = path => readFileSync(path, 'utf8')
const run = (directory, mode, cwd) => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(directory, 'scripts/messaging-matrix.mjs'), mode], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}
const fixture = action => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-board-matrix-'))
  try {
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'docs/validation'), { recursive: true })
    for (const file of ['messaging-matrix.mjs', 'message-client.mjs', ...connectors]) copyFileSync(join(root, 'scripts', file), join(directory, 'scripts', file))
    for (const file of matrixFiles) writeFileSync(join(directory, file), `Before ${file}\n${start}\n${end}\nAfter ${file}\n`)
    return action(directory)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
const putRecord = (directory, name, record) => {
  const path = join(directory, 'scripts', name)
  writeFileSync(path, 'export const messagingReceiver = ' + JSON.stringify(record) + '\n')
  return path
}

test('the messaging matrix is generated from each receiver record and CI fails when it is stale', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'agent-board-matrix-cwd-'))
  try {
    const records = await readReceiverRecords(root)
    for (const file of connectors) assert.ok(records.some(record => record.source === 'scripts/' + file), file)
    for (const record of records) {
      assert.equal(typeof record.isImplemented, 'boolean')
      assert.ok([1, 2, 3, 4].includes(record.tier))
      assert.match(record.primitive, /^(?:\[P[1-5]\]|unknown)$/)
    }
    for (const file of matrixFiles) {
      const table = renderMatrix(records, file, root)
      assert.ok(read(join(root, file)).replaceAll('\r\n', '\n').includes(table), file)
      for (const record of records) assert.ok(table.includes(record.source), record.source)
    }
    const checked = run(root, '--check', outside)
    assert.equal(checked.status, 0, checked.stderr)

    fixture(directory => {
      const initial = run(directory, '--check', outside)
      assert.equal(initial.status, 1)
      assert.match(initial.stderr, /stale/)
      for (const file of matrixFiles) assert.ok(!read(join(directory, file)).includes('| Host |'))
      assert.equal(run(directory, '--write', outside).status, 0)
      assert.equal(run(directory, '--check', outside).status, 0)
      assert.match(run(directory, '--write', outside).stdout, /Updated 0 /)
      for (const file of matrixFiles) {
        const path = join(directory, file), before = read(path)
        assert.ok(before.startsWith('Before ' + file + '\n'))
        assert.ok(before.endsWith('After ' + file + '\n'))
        writeFileSync(path, before.replace('Implemented', 'outdated'))
        const stale = run(directory, '--check', outside)
        assert.equal(stale.status, 1)
        assert.ok(stale.stderr.includes(file))
        assert.equal(read(path), before.replace('Implemented', 'outdated'))
        assert.equal(run(directory, '--write', outside).status, 0)
        assert.equal(read(path), before)
      }
      const before = connectors.map(file => read(join(directory, 'scripts', file)))
      putRecord(directory, 'new-receiver.mjs', {
        host: 'Synthetic Host', surfaces: [{ name: 'Synthetic IDE', evidence: null }],
        tier: 2, primitive: '[P4]', isImplemented: true,
      })
      assert.equal(run(directory, '--check', outside).status, 1)
      assert.equal(run(directory, '--write', outside).status, 0)
      assert.equal(run(directory, '--check', outside).status, 0)
      for (const file of matrixFiles) assert.match(read(join(directory, file)), /Synthetic Host \| Synthetic IDE \| 2 \| &#91;P4&#93; \| Implemented/)
      assert.deepEqual(connectors.map(file => read(join(directory, 'scripts', file))), before)

      const path = join(directory, 'README.md')
      writeFileSync(path, read(path).replace(end, ''))
      const bad = run(directory, '--write', outside)
      assert.equal(bad.status, 1)
      assert.match(bad.stderr, /markers/)
    })
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test('a receiver record marks a surface Verified only when it names a live-run file that exists', () => fixture(directory => {
  const evidence = 'docs/validation/2026-11-03-synthetic-host-live.md'
  writeFileSync(join(directory, evidence), '# Synthetic live-run fixture, not native evidence\n')
  mkdirSync(join(directory, 'docs/validation/2026-11-03-directory-live.md'))
  const record = {
    host: 'Synthetic Host', tier: 1, primitive: '[P1]', isImplemented: true,
    surfaces: [
      { name: 'CLI', evidence },
      { name: 'Desktop App', evidence: null },
      { name: 'IDE', evidence: 'docs/validation/2026-11-03-missing-live.md' },
      { name: 'Directory', evidence: 'docs/validation/2026-11-03-directory-live.md' },
      { name: 'Undated', evidence: 'docs/validation/notes.md' },
      { name: 'Traversal', evidence: 'docs/validation/../validation/2026-11-03-synthetic-host-live.md' },
    ],
  }
  writeFileSync(join(directory, 'docs/validation/notes.md'), '# Not a dated live run\n')
  putRecord(directory, 'synthetic-receiver.mjs', record)
  const rows = receiverRows([{ ...record, source: 'scripts/synthetic-receiver.mjs' }], directory)
  assert.deepEqual(rows.map(row => row.status), ['Verified', 'Implemented', 'Implemented', 'Implemented', 'Implemented', 'Implemented'])
  assert.deepEqual(rows.map(row => row.evidence), [evidence, null, null, null, null, null])
  assert.equal(receiverRows([{ ...record, isImplemented: false }], directory)[0].status, 'Proposed')

  const generated = run(directory, '--write', directory)
  assert.equal(generated.status, 0, generated.stderr)
  for (const file of matrixFiles) {
    const table = read(join(directory, file))
    assert.match(table, /Synthetic Host \| CLI \| 1 \| &#91;P1&#93; \| Verified/)
    assert.ok(table.includes((file.startsWith('docs/') ? '../' : '') + evidence))
    assert.ok(table.includes(file.includes('.zh-CN.') ? '未测试' : file.includes('.zh-TW.') ? '未測試' : 'Not tested'))
    assert.ok(!table.includes('missing-live.md'))
  }
  putRecord(directory, 'unnamed-primitive.mjs', { host: 'Unnamed Host', tier: 1, primitive: 'unknown', isImplemented: true, surfaces: [{ name: 'CLI', evidence: null }] })
  assert.equal(run(directory, '--write', directory).status, 0)
  for (const file of matrixFiles) assert.match(read(join(directory, file)), file.includes('.zh-') ? /Unnamed Host \| CLI \| 1 \| 未知 \|/ : /Unnamed Host \| CLI \| 1 \| Unknown \|/)
  rmSync(join(directory, evidence))
  assert.equal(run(directory, '--check', directory).status, 1)
  assert.equal(run(directory, '--write', directory).status, 0)
  for (const file of matrixFiles) assert.doesNotMatch(read(join(directory, file)), /\| Verified(?:（已驗證）|（已验证）)? \|/)
}))

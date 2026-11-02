// Read source and committed evidence only: never import a host test or start a process.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(resolve(root, path), 'utf8')
const matrix = JSON.parse(read('docs/parity-matrix.json'))
const baseline = JSON.parse(read('docs/parity-baseline.json'))
const hosts = ['claude-cli', 'claude-app', 'claude-ide', 'codex-cli', 'codex-app', 'codex-ide', 'antigravity-app', 'agy-cli', 'gemini-cli', 'cursor-ide', 'cursor-agent-cli', 'windsurf', 'devin-cli', 'copilot-vscode', 'copilot-cli', 'opencode', 'grok-build', 'hermes', 'openclaw', 'muse-dot', 'kiro', 'amp', 'cline', 'aider', 'goose', 'qwen-code', 'crush', 'droid', 'auggie']
const surfaces = ['pane', '--watch', '--chat', '--serve', 'progress.html', 'host-ui']
const capabilities = ['open-board', 'report-question', 'answer-question', 'archive-confirm-hide', 'message-agent', 'redact-default-view']
const levels = ['native', 'activity only', 'explicit report', 'opt-in resume', 'copy', 'paste or cooperative', 'none', 'unverified']
const key = cell => [cell.host, cell.surface, cell.capability].join('|')
const isFilled = cell => !['none', 'unverified'].includes(cell.level)
const nonempty = text => typeof text === 'string' && text.trim().length > 0
const sameSet = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort())

const checkEvidence = (cell, readSource) => {
  assert.ok(Array.isArray(cell.evidence), `${key(cell)}: evidence must be an array`)
  if (isFilled(cell)) assert.ok(cell.evidence.length > 0, `${key(cell)}: filled cell needs evidence`)
  for (const evidence of cell.evidence) {
    assert.equal(evidence.kind, 'synthetic-contract')
    assert.match(evidence.file, /^tests\/[a-zA-Z0-9/_.-]+\.test\.(?:mjs|ts|tsx)$/)
    assert.ok(!evidence.file.split('/').includes('..'), 'evidence must stay inside tests')
    assert.ok(resolve(root, evidence.file).startsWith(resolve(root, 'tests') + sep))
    assert.notEqual(evidence.file, 'tests/parity.test.mjs', 'the matrix cannot cite its own gate')
    assert.ok(nonempty(evidence.title))
    const source = readSource(evidence.file)
    // Anchoring a literal test declaration avoids mistaking a prose mention for a test.
    const titles = [...source.matchAll(/^\s*test\(\s*(['"])((?:\\.|(?!\1)[^\r\n])*)\1\s*,/gm)]
      .map(match => match[2].replace(/\\(['"\\])/g, '$1'))
    assert.equal(titles.filter(title => title === evidence.title).length, 1, `${key(cell)}: missing or ambiguous test ${evidence.title}`)
  }
}

const checkShape = value => {
  assert.equal(value.schemaVersion, 1)
  sameSet(value.hosts.map(host => host.id), hosts)
  sameSet(value.boardSurfaces, surfaces)
  sameSet(value.capabilities, capabilities)
  sameSet(value.legend, levels)
  for (const host of value.hosts) {
    assert.ok(nonempty(host.name) && nonempty(host.historicalStatus))
    assert.equal(host.validation, 'docs/validation/2026-10-20-parity-0.23.5.md')
    assert.ok(read(host.validation).includes('Live parity record'))
  }
  const expected = hosts.flatMap(host => surfaces.flatMap(surface => capabilities.map(capability => key({ host, surface, capability }))))
  sameSet(value.cells.map(key), expected)
  for (const cell of value.cells) {
    assert.ok(levels.includes(cell.level), `${key(cell)}: invalid level`)
    assert.ok(nonempty(cell.reason), `${key(cell)}: unknown must have a reason`)
    assert.ok(['required', 'not-required', 'unknown'].includes(cell.claudeSession))
    if (cell.surface === 'pane') assert.equal(cell.claudeSession, 'required')
  }
}

const checkBaseline = value => {
  assert.equal(value.schemaVersion, 1)
  assert.ok(nonempty(value.release) && nonempty(value.provenance))
  assert.match(value.releaseCommit, /^[a-f0-9]{40}$/)
  assert.ok(value.cells.length > 0, 'the release baseline cannot be empty')
  assert.equal(new Set(value.cells.map(key)).size, value.cells.length)
  for (const cell of value.cells) {
    assert.ok(hosts.includes(cell.host) && surfaces.includes(cell.surface) && capabilities.includes(cell.capability))
    assert.ok(levels.includes(cell.level) && isFilled(cell))
  }
}

const checkCount = (value, previous) => {
  checkBaseline(previous)
  assert.ok(value.cells.filter(isFilled).length >= previous.cells.filter(isFilled).length, 'filled parity count fell below the release baseline')
}

const checkTransitions = (value, previous) => {
  checkBaseline(previous)
  const current = new Map(value.cells.map(cell => [key(cell), cell]))
  const old = new Map(previous.cells.map(cell => [key(cell), cell]))
  const listed = new Map()
  for (const change of value.downgrades) {
    const id = key(change)
    assert.ok(!listed.has(id), `${id}: duplicate downgrade`)
    assert.equal(old.get(id)?.level, change.from)
    assert.equal(current.get(id)?.level, change.to)
    assert.notEqual(change.from, change.to)
    assert.ok(nonempty(change.reason))
    assert.match(change.issue, /^https:\/\/github\.com\/WenyuChiou\/agent-board\/issues\/[1-9]\d*$/)
    listed.set(id, change)
  }
  for (const cell of previous.cells) {
    const next = current.get(key(cell))
    assert.ok(next, `${key(cell)}: baseline cell was removed`)
    // These modes are not a universal rank: activity, explicit reports and resume
    // solve different problems. Require review for every changed filled mode.
    if (next.level !== cell.level) assert.ok(listed.has(key(cell)), `${key(cell)}: level changed without a listed downgrade`)
  }
}

test('every filled cell of the parity matrix cites a test that exists', () => {
  checkShape(matrix)
  for (const cell of matrix.cells) checkEvidence(cell, read)
  const filled = matrix.cells.find(isFilled)
  assert.throws(() => checkEvidence({ ...filled, evidence: [] }, read), /needs evidence/)
  assert.throws(() => checkEvidence(filled, () => '// test was removed\n'), /missing or ambiguous/)
  assert.throws(() => checkShape({ ...matrix, cells: matrix.cells.slice(1) }))
  assert.throws(() => checkShape({ ...matrix, cells: [...matrix.cells, matrix.cells[0]] }))
  assert.throws(() => checkEvidence({ ...filled, evidence: [{ ...filled.evidence[0], file: 'tests/../outside.test.mjs' }] }, read), /inside tests/)
})

test("the number of filled parity cells never goes below the last release's", () => {
  checkCount(matrix, baseline)
  assert.throws(() => checkCount({ cells: [] }, baseline), /count fell/)
  assert.throws(() => checkCount(matrix, { ...baseline, cells: [] }), /cannot be empty/)
})

test('no parity cell drops a level without a listed downgrade', () => {
  checkTransitions(matrix, baseline)
  const changed = structuredClone(matrix)
  changed.cells.find(cell => key(cell) === key(baseline.cells[0])).level = 'unverified'
  assert.throws(() => checkTransitions(changed, baseline), /without a listed downgrade/)
  // Adding another filled cell cannot conceal the loss of an existing capability.
  changed.cells.find(cell => cell.level === 'unverified' && key(cell) !== key(baseline.cells[0])).level = 'copy'
  checkCount(changed, baseline)
  assert.throws(() => checkTransitions(changed, baseline), /without a listed downgrade/)
  changed.downgrades.push({ ...baseline.cells[0], from: baseline.cells[0].level, to: 'unverified', reason: 'Synthetic regression fixture only', issue: 'https://github.com/WenyuChiou/agent-board/issues/252' })
  checkTransitions(changed, baseline)
  changed.downgrades[0].reason = ''
  assert.throws(() => checkTransitions(changed, baseline))
})

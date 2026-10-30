import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ambitionQuestions, foldText, fragmentIssue, orderFragments, parseArgs, parseFragment, runFold, stripTests } from '../scripts/changelog-fold.mjs'

const script = fileURLToPath(new URL('../scripts/changelog-fold.mjs', import.meta.url))
const summary = issue => `- **Synthetic entry (#${issue}).** A synthetic result.`
const entry = issue => `${summary(issue)}\n  Tests: \`a synthetic result has coverage\`.\n`
const fragment = (issue, slug = 'synthetic') => ({ path: `changelog.d/${issue}-${slug}.md`, text: entry(issue) })
const history = '## 1.0.0 — 2026-01-01\n\nHistorical bytes.  \n\n### A subsection\n\nNo final newline'
const text = '# Changelog\n\n## Unreleased\n\n' + entry(10) + '\n' + history
const fold = options => foldText({ text, fragments: [fragment(42)], version: '1.1.0', date: '2026-02-01', ...options })
const fixture = t => {
  const cwd = mkdtempSync(join(tmpdir(), 'synthetic-changelog-fold-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  mkdirSync(join(cwd, 'changelog.d'))
  writeFileSync(join(cwd, 'CHANGELOG.md'), text)
  writeFileSync(join(cwd, 'changelog.d/README.md'), 'Synthetic instructions.\n')
  writeFileSync(join(cwd, 'changelog.d/42-synthetic.md'), entry(42))
  return cwd
}

test('the fold puts fragments newest issue first above the Unreleased entries', () => {
  const fragments = [fragment(2), fragment(42, 'zeta'), fragment(42, 'alpha')]
  const result = fold({ fragments })
  assert.deepEqual(result.fragments, ['changelog.d/42-alpha.md', 'changelog.d/42-zeta.md', 'changelog.d/2-synthetic.md'])
  assert.equal(result.unreleasedCount, 1)
  assert.equal(result.text, '# Changelog\n\n## 1.1.0 — 2026-02-01\n\n' + summary(42) + '\n\n' + summary(42) + '\n\n' + summary(2) + '\n\n' + summary(10) + '\n\n' + history)
  assert.deepEqual(fragments.map(item => item.path), ['changelog.d/2-synthetic.md', 'changelog.d/42-zeta.md', 'changelog.d/42-alpha.md'])
  assert.ok(!result.text.includes('## Unreleased'))
})

test('a folded section keeps each entry and leaves out its Tests line and trailing Tests sentence', () => {
  const fragments = [
    { path: 'changelog.d/42-separate.md', text: '- Separate result (#42).\n  Tests: `separate coverage`.\n' },
    { path: 'changelog.d/43-trailing.md', text: '- Trailing result (#43). Tests: `trailing coverage`.\n' },
  ]
  const input = '# Changelog\r\n\r\n## Unreleased\r\n\r\n- Kept result (#10)! Test: `kept coverage`.\r\n  Tests: `legacy coverage`.\r\n\r\n' + history.replaceAll('\n', '\r\n')
  const result = fold({ text: input, fragments }).text
  assert.equal(result, '# Changelog\r\n\r\n## 1.1.0 — 2026-02-01\r\n\r\n- Trailing result (#43).\r\n\r\n- Separate result (#42).\r\n\r\n- Kept result (#10)!\r\n\r\n' + history.replaceAll('\n', '\r\n'))
  assert.doesNotMatch(result, /Tests?:/)
  assert.doesNotMatch(result, /(?<!\r)\n/)
})

test('a wrapped Tests list is left out whole, and one that more of the entry follows is kept as written', () => {
  const cases = [
    ['- Wrapped (#44).\n  Tests: `a title that\n  wraps`, `a second\n  title`.\n\n- Next (#45).\n', '- Wrapped (#44).\n\n- Next (#45).\n'],
    ['- Inline (#46). Tests: "one" and\n  "two".\n## 1.0.0\n', '- Inline (#46).\n## 1.0.0\n'],
    ['- Each ends (#48)! Test: `a`.\n- Question (#49)? Tests: `b`.\n- Paren (#50) Tests: `c`.\n', '- Each ends (#48)!\n- Question (#49)?\n- Paren (#50)\n'],
    ['- Mid (#47). Tests: "a" and "b". This is part\n  of #47.\n', '- Mid (#47). Tests: "a" and "b". This is part\n  of #47.\n'],
    ['- Quote (#51).\n  Tests: `shows an unmatched " in output`.\n- Next (#52).\n  Tests: `another title`.\n', '- Quote (#51).\n- Next (#52).\n'],
    ['- Same line (#53).\n  Tests: `one title`. This sentence is part of the entry.\n', '- Same line (#53).\n  Tests: `one title`. This sentence is part of the entry.\n'],
    ['- Code after (#54).\n  Tests: `one title`.\n  `progress.md` remains unchanged.\n', '- Code after (#54).\n  Tests: `one title`.\n  `progress.md` remains unchanged.\n'],
    ['- Reason (#55). Tests: `a` and `b` (the CI exposed this race).\n', '- Reason (#55). Tests: `a` and `b` (the CI exposed this race).\n'],
    ['- Docs (#56).\n  Tests: none (documentation only).\n', '- Docs (#56).\n'],
    ['- Tick (#57).\n  Tests: "shows a ` in output"\n  "This sentence is part of the entry."\n- Next (#58).\n', '- Tick (#57).\n  Tests: "shows a ` in output"\n  "This sentence is part of the entry."\n- Next (#58).\n'],
    ['- Soft break (#59).\n  Tests: `a first title`\n  `a second title`.\n', '- Soft break (#59).\n  Tests: `a first title`\n  `a second title`.\n'],
    ['Ordinary text mentions tests within a sentence.\nTest-only change.\nA colon Test: remains.\n', 'Ordinary text mentions tests within a sentence.\nTest-only change.\nA colon Test: remains.\n'],
    ['Keep.\n  Tests: `final title`', 'Keep.\n'],
    ['Keep.\n  Tests: final line', 'Keep.\n  Tests: final line'],
  ]
  for (const eol of ['\n', '\r\n']) {
    for (const [input, kept] of cases) assert.equal(stripTests(input.replaceAll('\n', eol)), kept.replaceAll('\n', eol))
  }
})

test('a fragment without a Tests line is still refused', () => {
  const missing = { path: 'changelog.d/42-missing.md', text: '- Missing coverage (#42).\n' }
  assert.throws(() => parseFragment(missing), /no Tests: line/)
  assert.throws(() => fold({ fragments: [missing] }), /no Tests: line/)
})

test('the fold keeps everything below the new version byte for byte', () => {
  for (const suffix of [history, history.replaceAll('\n', '\r\n'), history + '\n\n']) {
    const result = fold({ text: '# Changelog\n\n## Unreleased\n\n' + entry(10) + '\n' + suffix })
    assert.deepEqual(Buffer.from(result.text.slice(result.text.indexOf('## 1.0.0'))), Buffer.from(suffix))
  }
  assert.ok(fold({ text: '# Changelog\n\n' + history }).text.endsWith(history))
})

test('the fold refuses a version that already has a heading', () => {
  assert.throws(() => fold({ version: '1.0.0' }), /already has a heading/)
  assert.throws(() => fold({ text: text + '\n## 1.1.0\n' }), /already has a heading/)
})

test('the fold refuses when there is nothing to release', () => {
  assert.throws(() => fold({ text: '# Changelog\n\n## Unreleased\n\n' + history, fragments: [] }), /nothing to release/)
  assert.throws(() => fold({ text: '# Changelog\n\n' + history, fragments: [{ path: 'changelog.d/README.md', text: 'instructions' }] }), /nothing to release/)
  assert.equal(fold({ fragments: [] }).unreleasedCount, 1)
})

test('the fold refuses a fragment that does not name its issue', () => {
  assert.throws(() => fold({ fragments: [{ path: 'changelog.d/42-synthetic.md', text: entry(420) }] }), /does not name #42/)
  assert.throws(() => parseFragment({ path: 'changelog.d/42-Bad.md', text: entry(42) }), /invalid fragment name/)
  assert.throws(() => parseFragment({ path: 'changelog.d/42-valid.md', text: '- Synthetic (#42).' }), /no Tests:/)
})

test('the fold keeps CRLF line endings', () => {
  const input = text.replaceAll('\n', '\r\n')
  const output = fold({ text: input }).text
  assert.equal(output.replaceAll('\r\n', '').includes('\n'), false)
  assert.ok(output.endsWith(history.replaceAll('\n', '\r\n')))
})

test('the fold leaves one blank line between sections with mixed line endings', () => {
  for (const prefix of ['# Changelog\n\n', '# Changelog\n', '# Changelog\r\n\n']) {
    const result = fold({ text: prefix + '## Unreleased\n\n' + entry(10) + '\n' + history.replaceAll('\n', '\r\n') })
    const expectedPrefix = prefix === '# Changelog\n' ? prefix + '\n' : prefix
    assert.ok(result.text.startsWith(expectedPrefix + '## 1.1.0 — 2026-02-01\r\n\r\n'))
    assert.ok(result.text.endsWith('\r\n\r\n' + history.replaceAll('\n', '\r\n')))
  }
  const result = fold({ text: '# Changelog\n\n## Unreleased\n\n' + entry(10) + '\n\n' })
  assert.ok(result.text.endsWith(summary(10) + '\n'))
  assert.equal(result.text.endsWith('\n\n'), false)
})

test('the fold with --write refuses before writing when a fragment cannot be removed', t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'changelog.d/43-synthetic.md'), entry(43))
  const paths = ['CHANGELOG.md', 'changelog.d/README.md', 'changelog.d/43-synthetic.md', 'changelog.d/42-synthetic.md']
  const before = paths.map(path => readFileSync(join(cwd, path)))
  for (const blocked of ['CHANGELOG.md', 'changelog.d/42-synthetic.md']) {
    const checked = []
    const lines = []
    assert.throws(() => runFold({
      cwd, argv: ['1.1.0', '--date', '2026-02-01', '--write'], log: line => lines.push(line),
      checkWritable: path => {
        checked.push(path)
        if (path === join(cwd, blocked)) throw new Error('synthetic locked file')
      },
    }), /synthetic locked file/)
    assert.deepEqual(checked, blocked === 'CHANGELOG.md' ? [join(cwd, blocked)] : paths.filter(path => path !== 'changelog.d/README.md').map(path => join(cwd, path)))
    assert.deepEqual(paths.map(path => readFileSync(join(cwd, path))), before)
    assert.deepEqual(lines, [])
  }
})

test('a dry run changes no file', t => {
  const cwd = fixture(t)
  const paths = ['CHANGELOG.md', 'changelog.d/README.md', 'changelog.d/42-synthetic.md']
  const before = paths.map(path => readFileSync(join(cwd, path)))
  const lines = []
  runFold({ cwd, argv: ['1.1.0', '--date', '2026-02-01'], log: line => lines.push(line) })
  assert.deepEqual(paths.map(path => readFileSync(join(cwd, path))), before)
  assert.match(lines.join('\n'), /Dry run: ## 1.1.0 — 2026-02-01/)
  assert.match(lines.join('\n'), /changelog.d\/42-synthetic.md/)
  assert.match(lines.join('\n'), /Unreleased entries kept: 1/)
})

test('the fold with --write rewrites the CHANGELOG and removes only the folded fragments', t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'unrelated.md'), 'Synthetic unrelated bytes.\n')
  writeFileSync(join(cwd, 'CHANGELOG.md'), text.replaceAll('\n', '\r\n'))
  const execution = spawnSync(process.execPath, [script, '1.1.0', '--date', '2026-02-01', '--write'], { cwd, encoding: 'utf8' })
  assert.equal(execution.status, 0, execution.stdout + execution.stderr)
  assert.equal(existsSync(join(cwd, 'changelog.d/42-synthetic.md')), false)
  assert.deepEqual(readdirSync(join(cwd, 'changelog.d')), ['README.md'])
  assert.equal(readFileSync(join(cwd, 'changelog.d/README.md'), 'utf8'), 'Synthetic instructions.\n')
  assert.equal(readFileSync(join(cwd, 'unrelated.md'), 'utf8'), 'Synthetic unrelated bytes.\n')
  assert.equal(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), fold({ text: text.replaceAll('\n', '\r\n') }).text)
  assert.match(execution.stdout, /changelog.d\/42-synthetic.md/)
})

test('the fold validates arguments before changing files', t => {
  const cwd = fixture(t)
  const before = readFileSync(join(cwd, 'CHANGELOG.md'))
  for (const argv of [[], ['v1.2.3'], ['1.2.3', '--date', '2026-02-30'], ['1.2.3', '--date', 'bad'], ['1.2.3', '--unknown'], ['1.2.3', '--write', '--write']]) {
    assert.throws(() => runFold({ cwd, argv, log: () => {} }))
    assert.deepEqual(readFileSync(join(cwd, 'CHANGELOG.md')), before)
  }
  assert.equal(parseArgs(['1.2.3'], new Date('2026-03-01T00:01:00Z')).date, '2026-03-01')
  assert.equal(fragmentIssue('changelog.d/42-valid-slug2.md'), '42')
  assert.equal(fragmentIssue('changelog.d/0042-valid.md'), null)
  assert.throws(() => fold({ fragments: [{ path: 'changelog.d/0042-valid.md', text: entry(42) }] }), /invalid fragment name/)
  const hugeIssue = '9'.repeat(400)
  assert.equal(fold({ fragments: [fragment(42), fragment(hugeIssue)] }).fragments[0], `changelog.d/${hugeIssue}-synthetic.md`)
  assert.deepEqual(orderFragments([parseFragment(fragment(2)), parseFragment(fragment(100))]).map(item => item.issue), ['100', '2'])
})

test('the fold with --write ends with the three next-version questions and a dry run prints none', t => {
  const cwd = fixture(t)
  const dry = []
  runFold({ cwd, argv: ['1.1.0', '--date', '2026-02-01'], log: line => dry.push(line) })
  assert.ok(!dry.join('\n').includes('Before planning'))
  const lines = []
  runFold({ cwd, argv: ['1.1.0', '--date', '2026-02-01', '--write'], log: line => lines.push(line) })
  assert.equal(ambitionQuestions.length, 3)
  assert.deepEqual(lines.slice(-4), ['\nBefore planning the next version, answer in its plan:', ...ambitionQuestions.map((question, index) => `${index + 1}. ${question}`)])
  assert.match(lines.join('\n'), /goal sits above[^]*hard number[^]*other field/)
})

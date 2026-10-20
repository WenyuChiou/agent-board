import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TOTAL_CAP, addedLines, apiReader, authorKey, authorLine, binaryImages, cap, changelog, checkPr, claimed,
  isGovernancePath, issueLine, main, naming, needsBundle, privateData, report, reportMarkdown,
  sections, stripComments, testTitles, titleKnown, verdict,
} from '../scripts/pr-check.mjs'

const script = fileURLToPath(new URL('../scripts/pr-check.mjs', import.meta.url))
const branch = 'fix/synthetic-check'
const template = '## What and why\n\n## Checks\n\n- [ ] Run the tests\n'
const body = `<!-- instructions -->\nFixes #42\nAuthor: Codex (local), branch \`${branch}\`; supervisor fixes in docs\n\n## What and why\nChecks a synthetic change.\n\n## Checks\n- [x] Run the tests - passed\n`
const coveringTitle = 'a synthetic check explains the result'
const titles = testTitles([{ path: 'tests/x.test.mjs', text: `test('${coveringTitle}', () => {})` }])
const entry = `- A synthetic change (#42). Tests: \`${coveringTitle}\`.`
const changelogData = (text = `# Changelog\n\n## Unreleased\n\n${entry}\n\n## 1.0.0\n`) => ({
  text,
  added: [{ path: 'CHANGELOG.md', line: 5, text: linesOf(text)[4] }],
  issue: 42, titles, isRelease: false, isDocsOnly: false,
})
const linesOf = text => text.split('\n')
const syntheticPr = () => ({
  number: 17, title: 'fix: explain synthetic checks', body, branch, head: 'abcdef1234567890abcdef1234567890abcdef12',
  template, changelogText: changelogData().text, added: changelogData().added,
  paths: ['CHANGELOG.md', 'tests/x.test.mjs'], changedPaths: ['CHANGELOG.md', 'tests/x.test.mjs'], testFiles: [{ path: 'tests/x.test.mjs', text: `test('${coveringTitle}', () => {})` }],
  issueData: { state: 'open' }, issueComments: [{ body: `Claim: codex, ${branch}, until 2030-01-01 00:00 UTC` }],
  open: [], prComments: [], labels: [], isDraft: false,
})

const fixture = (t, testTitle = coveringTitle) => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-pr-check-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const put = (path, text) => {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  const git = (...args) => {
    const execution = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(execution.status, 0, execution.stderr || execution.error?.message)
    return execution.stdout.trim()
  }
  const commit = () => {
    git('add', '--', '.github/pull_request_template.md', 'CHANGELOG.md', 'tests/x.test.mjs')
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test: synthetic fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '--initial-branch=main')
  put('.github/pull_request_template.md', template)
  put('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.0.0\n')
  put('tests/x.test.mjs', `test('${coveringTitle}', () => {})\n`)
  const base = commit()
  git('switch', '-c', branch)
  put('CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n- A synthetic change (#42). Tests: \`${testTitle}\`.\n\n## 1.0.0\n`)
  const head = commit()
  put('body.txt', body)
  const run = (args = [], env = {}) => runMain(['--body-file', join(directory, 'body.txt'), '--title', 'fix: synthetic check', '--base', base, '--repo-dir', directory, '--offline', '--no-bundle', ...args], env)
  return { directory, put, git, base, head, run }
}

// Runs main in this process as the command line would: starting Node for every case is slow on Windows CI.
const runMain = async (args, env = {}) => {
  const stdout = []
  const stderr = []
  const { log, error } = console
  const changed = { GITHUB_STEP_SUMMARY: undefined, ...env }
  const saved = Object.fromEntries(Object.keys(changed).map(key => [key, process.env[key]]))
  const apply = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  console.log = text => stdout.push(text)
  console.error = text => stderr.push(text)
  apply(changed)
  try {
    return { status: await main(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') }
  } finally {
    console.log = log
    console.error = error
    apply(saved)
  }
}

test('pr-check accepts a conforming pull request body and a CHANGELOG entry whose test titles exist', async t => {
  const execution = await fixture(t).run()
  assert.equal(execution.status, 0, execution.stderr || execution.stdout)
  assert.match(execution.stdout, /all checks passed/)
  for (const check of ['issue status', 'claim', 'cap', 'review']) assert.ok(execution.stdout.includes(`${check}: skipped (offline)`))
})

test('pr-check fails a body without a Fixes or Part of line and says how to add it', () => {
  const checked = issueLine('Author: codex, fix/example', 'fix: example')
  assert.equal(checked.problems.length, 1)
  assert.match(checked.problems[0].fix, /Fixes #N.*Part of #N/)
  assert.equal(issueLine('<!-- hidden -->\n\nPart of #42\n', 'fix: example').issue, 42)
  assert.equal(issueLine('Fixes #42\nResolves: #43', 'fix: example').problems.length, 1)
  assert.equal(issueLine('Fixes #42\n<!-- Closes #43 -->', 'fix: example').problems.length, 0)
})

test('pr-check fails an Author line that names another branch', () => {
  assert.ok(authorLine('Author: codex, fix/other', branch).problems.length)
  assert.ok(authorLine(`Author: codex, ${branch}-extra`, branch).problems.length)
  assert.ok(authorLine('Author: codex, fix/axb', 'fix/a.b').problems.length)
  assert.ok(authorLine('Author: <agent>, fix/example', 'fix/example').problems.length)
  assert.ok(authorLine('Author: dot fix/example', 'fix/example').problems.length)
  assert.ok(authorLine('Author: dot fix/example, notes', 'fix/example').problems.length)
  assert.equal(authorLine('Author: dot, `fix/example`', 'fix/example').problems.length, 0)
  assert.equal(authorLine(body, branch).agent, 'codex')
  assert.equal(authorLine(body, branch).problems.length, 0)
})

test('pr-check fails an empty template section and an unchanged checkbox', () => {
  const checked = sections('## What and why\n<!-- empty -->\n## Checks\n- [ ] Run the tests\n', template)
  assert.equal(checked.problems.length, 2)
  assert.equal(sections('## What and why\nDone\n## Checks\n- [x] Run the tests\n', template).problems.length, 1)
  assert.equal(sections(body.replace('## What and why', '## WHAT AND WHY'), template).problems.length, 0)
  assert.equal(sections(body.replace('- [x] Run the tests - passed', '- [ ] Run the tests - not run: unavailable'), template).problems.length, 0)
})

test('pr-check fails a CHANGELOG title that no test has and names it', async t => {
  const execution = await fixture(t, 'a synthetic nonexistent test').run()
  assert.equal(execution.status, 1)
  assert.match(execution.stdout, /"a synthetic nonexistent test" is not the title/)
  assert.match(execution.stdout, /Fix:/)
})

test('pr-check fails an entry added under a released version instead of Unreleased', () => {
  const checked = changelog({ ...changelogData('# Changelog\n\n## Unreleased\n\n## 1.0.0\n\n' + entry), added: [{ path: 'CHANGELOG.md', line: 7, text: entry }] })
  assert.equal(checked.problems.length, 1)
  assert.match(checked.problems[0].message, /## 1.0.0/)
  assert.match(checked.problems[0].fix, /move.*Unreleased/)
  const missing = changelog({ ...changelogData(), text: '# Changelog\n## 1.0.0\n' })
  assert.match(missing.problems[0].fix, /above the newest version/)
})

test('pr-check matches template-literal test titles and placeholder names', () => {
  const parsed = testTitles([{ path: 'tests/nested/x.test.tsx', text: [
    'test(`the ${agent} reports ${state}`, () => {})',
    'it.only("a fixed title", () => {})',
    "test.skip('a \\'quoted\\' title', () => {})",
    'it.todo("a \\\"double\\\" title")',
    'test(`a static backtick title`, () => {})',
    "test('a \\\\ path', () => {})",
  ].join('\n') }])
  assert.ok(titleKnown('the codex reports working', parsed))
  assert.ok(titleKnown('the <agent> reports <state>', parsed))
  assert.ok(titleKnown('the <who> reports <what>', parsed))
  // A placeholder names a template title of the same shape only, so it cannot stand for any title.
  assert.equal(titleKnown('a <kind> title', parsed), false)
  assert.equal(titleKnown('<any>', parsed), false)
  assert.equal(titleKnown('the <agent> reports', parsed), false)
  // Matching runs in linear time: before, adjacent placeholders built a pattern that took minutes.
  const many = testTitles([{ path: 'tests/x.test.mjs', text: 'test(`${a}${b}${c}${d}${e}${f}${g}${h}x`, () => {})' }])
  const started = Date.now()
  assert.equal(titleKnown(`${'a'.repeat(20000)}!`, many), false)
  assert.ok(titleKnown(`${'a'.repeat(20000)}x`, many))
  assert.equal(titleKnown(`${'<a>'.repeat(50)}!`, { ...titles, exact: new Set(Array.from({ length: 50 }, (_, index) => `synthetic title ${index}`)) }), false)
  assert.ok(Date.now() - started < 10000)
  // A template title with no words matches nothing, or it would stand for any title.
  const bare = testTitles([{ path: 'tests/x.test.mjs', text: ['test(`${name}`, () => {})', 'test(`${a} ${b}`, () => {})'].join('\n') }])
  for (const span of ['<any>', '<x> <y>', 'any made-up title']) assert.equal(titleKnown(span, bare), false, span)
  assert.ok(titleKnown("a 'quoted' title", parsed))
  assert.ok(titleKnown('a "double" title', parsed))
  assert.ok(titleKnown('a \\ path', parsed))
  assert.ok(titleKnown('a static backtick title', parsed))
  assert.equal(titleKnown('the  reports working', parsed), false)
  assert.equal(titleKnown('prefix the codex reports working', parsed), false)
})

const openPr = (number, author, extra = {}) => ({ number, title: 'fix: synthetic', body: `Fixes #${number}\nAuthor: ${author}, fix/synthetic-${number}`, createdAt: `2030-01-01T00:00:${String(number).padStart(2, '0')}Z`, labels: [], ...extra })

test('pr-check fails the newest pull request over the cap and keeps older ones', () => {
  const open = Array.from({ length: TOTAL_CAP + 1 }, (_, index) => openPr(index + 1, `agent-${index + 1}`)).reverse()
  assert.equal(cap({ open, number: 1 }).problems.length, 0)
  assert.equal(cap({ open, number: TOTAL_CAP }).problems.length, 0)
  const over = cap({ open, number: TOTAL_CAP + 1 })
  assert.equal(over.problems.length, 1)
  assert.match(over.problems[0].message, /9 pull requests would be open, over the 8 in all; counted: #1, #2, #3, #4, #5, #6, #7, #8, #9/)
  assert.match(over.problems[0].fix, /waiting for a slot/)
  assert.equal(cap({ open: open.slice(1), number: null, body: 'Author: agent-new, fix/new' }).problems.length, 1)
  const exemptions = open.map(pr => pr.number === 9 ? { ...pr, labels: [{ name: 'cap-exempt' }] } : pr)
  assert.equal(cap({ open: exemptions, number: 9 }).problems.length, 0)
  assert.equal(cap({ open: open.map(pr => pr.number === 9 ? { ...pr, title: 'chore(release): synthetic' } : pr), number: 9 }).problems.length, 0)
  assert.equal(cap({ open: [], number: null, body: 'Author: agent-new, fix/new' }).problems.length, 0)
})

test('pr-check counts each author and lane on its own and leaves governance pull requests out of the cap', () => {
  const open = [openPr(1, 'dot'), openPr(2, '`Dot`'), openPr(3, 'dot'), openPr(4, 'codex (phase1)'), openPr(5, 'Codex (phase1)'), openPr(6, 'codex (e2e)')]
  assert.equal(cap({ open, number: 2 }).problems.length, 0)
  const third = cap({ open, number: 3 })
  assert.equal(third.problems.length, 1)
  assert.match(third.problems[0].message, /"dot" would have 3 open pull requests, over 2 per author: #1, #2, #3/)
  assert.match(third.problems[0].fix, /codex \(phase1\)/)
  assert.equal(cap({ open, number: 5 }).problems.length, 0)
  assert.equal(cap({ open, number: 6 }).problems.length, 0)
  assert.equal(cap({ open, number: null, body: 'Author: codex (phase1), fix/next' }).problems.length, 1)
  assert.equal(cap({ open, number: null, body: 'Author: codex (contrib), fix/next' }).problems.length, 0)
  const governed = open.map(pr => pr.number === 1 ? { ...pr, isGovernance: true } : pr)
  assert.equal(cap({ open: governed, number: 3 }).problems.length, 0)
  assert.equal(authorKey('<!-- Author: hidden -->\nAuthor:  `Codex  (Phase1)`, branch `fix/x`'), 'codex (phase1)')
  assert.equal(authorKey('Fixes #1'), null)
  assert.ok(['AGENTS.md', 'CONTRIBUTING.md', '.github/workflows/test.yml'].every(isGovernancePath))
  assert.ok(!['docs/CONTRIBUTOR-PATH.md', 'scripts/pr-check.mjs'].some(isGovernancePath))
  const data = { ...syntheticPr(), open: [openPr(1, 'codex (local)'), openPr(2, 'codex (local)')], number: null }
  assert.ok(checkPr(data).problems.some(item => item.check === 'cap'))
  assert.ok(checkPr({ ...data, paths: [...data.paths, 'CONTRIBUTING.md'] }).info.includes('cap: this pull request is exempt.'))
})

test('pr-check finds a session id, a home-folder path and a token link in added docs and the body', () => {
  const token = 'syntheticToken01234567890123456789'
  const session = '12345678-abcd-4ef0-9876-abcdef123456'
  const text = `${session} C:\\Users\\private-synthetic\\file https://example.invalid/?token=${token}`
  const checked = privateData({ added: [{ path: 'docs/example.txt', line: 7, text }], body: text })
  assert.equal(checked.problems.length, 6)
  const output = report(checked, 'synthetic') + reportMarkdown(checked, 'synthetic')
  assert.match(output, /docs\/example.*line 7/)
  assert.match(output, /body line 1/)
  for (const value of [token, session, 'private-synthetic']) assert.equal(output.includes(value), false)
  for (const value of ['/mnt/c/Users/private-synthetic/file', '/var/home/private-synthetic/file', 'file:///home/private-synthetic/file', 'vscode-remote://wsl+Ubuntu/home/private-synthetic/file', 'ssh://synthetic@host.invalid/home/private-synthetic/file','/home/private-synthetic/file', '/Users/private-synthetic/file', 'C:\\\\Users\\\\private-synthetic\\\\file', 'C:/Users/private-synthetic/file']) {
    assert.equal(privateData({ added: [], body: value }).problems.length, 1)
  }
  for (const value of ['/home/you/file', '/Users/<name>/file', 'C:/Users/runner/file', '/home/$USER/file', '/home/%USER%/file', '00000000-0000-0000-0000-000000000001', 'https://github.com/users/octocat/projects/1', 'https://example.com/home/index.html', 'https://docs.github.com/en/rest/users/users']) {
    assert.equal(privateData({ added: [], body: value }).problems.length, 0, value)
  }
})

test('pr-check requires synthetic alt text for images in the body', () => {
  for (const text of ['![Board](example.svg)', '<img src="example.svg">', '<img alt="Board" src="example.svg">', '<img data-alt="Synthetic board" src="example.svg">', '<img title=\' alt="Synthetic"\'>']) {
    assert.equal(privateData({ added: [], body: text }).problems.length, 1)
  }
  for (const text of ['![Synthetic board](example.svg)', '<img alt="Synthetic board" src="example.svg">', "<img alt='SYNTHETIC board'>", '<img alt=Synthetic>']) {
    assert.equal(privateData({ added: [], body: text }).problems.length, 0)
  }
})

test('pr-check exempts releases, asks an entry only of fix and feature pull requests and permits Tests none only for documentation changes', () => {
  const optional = changelog({ ...changelogData(), added: [], isRequired: false })
  assert.equal(optional.problems.length, 0)
  assert.match(optional.info[0], /no entry needed/)
  assert.equal(changelog({ ...changelogData(), text: '# Changelog\n## 1.0.0\n', isRequired: false }).problems.length, 0)
  assert.equal(changelog({ ...changelogData('# Changelog\n\n## Unreleased\n\n- A change (#42). Tests: `an unknown synthetic title`\n'), isRequired: false }).problems.some(item => /is not the title/.test(item.message)), true)
  assert.equal(checkPr({ ...syntheticPr(), title: 'docs: explain synthetic checks', added: [] }).problems.length, 0)
  assert.ok(checkPr({ ...syntheticPr(), title: 'feat!: synthetic', added: [] }).problems.some(item => item.check === 'changelog'))
  const split = '# Changelog\n\n## Unreleased\n\n- A change (#42). Tests: `a synthetic\ncheck explains the result`\n'
  const spanning = changelog({ ...changelogData(split), added: [5, 6].map(line => ({ path: 'CHANGELOG.md', line, text: linesOf(split)[line - 1] })) })
  assert.deepEqual(spanning.problems.map(item => item.message), ['the entry contains no known covering test title.'])
  assert.equal(issueLine('', 'chore(release): 1.0.0').issue, null)
  assert.equal(issueLine('', 'chore(release): 1.0.0').problems.length, 0)
  assert.equal(changelog({ ...changelogData(), text: '', isRelease: true }).problems.length, 0)
  const none = changelogData('# Changelog\n\n## Unreleased\n\n- A synthetic change (#42). Tests: none\n')
  assert.equal(changelog({ ...none, isDocsOnly: true }).problems.length, 0)
  assert.equal(changelog(none).problems.length, 1)
  assert.equal(changelog({ ...changelogData('# Changelog\n\n## Unreleased\n\n- A change (#42). Tests: none; `an unknown synthetic title`\n'), isDocsOnly: true }).problems.length, 1)
  assert.ok(changelog({ ...changelogData(), added: [] }).problems.length)
  assert.ok(changelog({ ...changelogData(), issue: 420 }).problems.length)
  assert.ok(changelog(changelogData('# Changelog\n\n## Unreleased\n\n- A change (#42).\n')).problems.length)
  assert.ok(changelog(changelogData('# Changelog\n\n## Unreleased\n\n- A change (#42). Tests: `tests/x.test.mjs`\n')).problems.length)
})

test('pr-check tracks added line numbers across hunks and ignores deleted files and newline markers', () => {
  const diff = [
    'diff --git a/docs/example.md b/docs/example.md', '--- a/docs/example.md', '+++ b/docs/example.md',
    '@@ -1 +1,2 @@', '-old', '+new', '+++ content', '\\ No newline at end of file',
    '@@ -9,0 +11,2 @@', '+later', '+last',
    'diff --git a/old.md b/old.md', '--- a/old.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-removed',
    'diff --git "a/docs/with space.md" "b/docs/with space.md"', '--- /dev/null', '+++ "b/docs/with space.md"', '@@ -0,0 +1 @@', '+created',
    'diff --git "a/docs/\\303\\251.md" "b/docs/\\303\\251.md"', '--- /dev/null', '+++ "b/docs/\\303\\251.md"', '@@ -0,0 +1 @@', '+unicode',
    // What git really writes for a name with a space and no other special character: a tab after it.
    'diff --git a/docs/README x.md b/docs/README x.md', '--- /dev/null', '+++ b/docs/README x.md\t', '@@ -0,0 +1 @@', '+spaced',
  ].join('\n')
  assert.deepEqual(addedLines(diff), [
    { path: 'docs/example.md', line: 1, text: 'new' },
    { path: 'docs/example.md', line: 2, text: '++ content' },
    { path: 'docs/example.md', line: 11, text: 'later' },
    { path: 'docs/example.md', line: 12, text: 'last' },
    { path: 'docs/with space.md', line: 1, text: 'created' },
    { path: 'docs/é.md', line: 1, text: 'unicode' },
    { path: 'docs/README x.md', line: 1, text: 'spaced' },
  ])
})

test('pr-check checks naming and accepts both old and new branch claims', () => {
  assert.equal(naming('fix(parser)!: synthetic', branch).problems.length, 0)
  assert.equal(naming('bad title', 'Bad/branch').problems.length, 2)
  assert.equal(claimed([{ body: `Claiming as CODEX on \`${branch}\`` }], 'codex', branch).problems.length, 0)
  assert.equal(claimed([{ body: `Claim: codex, ${branch}, until 2030-01-01 00:00 UTC` }], 'codex', branch).problems.length, 0)
  assert.equal(claimed([{ body: `Claim: notcodex, ${branch}` }], 'codex', branch).problems.length, 1)
  assert.equal(needsBundle(['docs/example.md']), false)
  assert.equal(needsBundle(['scripts/example.mjs']), true)
  assert.equal(needsBundle(['hooks/example.ts']), true)
  assert.equal(stripComments('a<!-- hidden\ntext -->b'), 'ab')
})

test('pr-check rejects embedded bitmaps and binary images except generated social previews', () => {
  assert.equal(privateData({ body: '', added: [{ path: 'docs/example.svg', line: 2, text: '<image href="data:image/png;base64,synthetic">' }] }).problems.length, 1)
  assert.equal(binaryImages(['docs/example.png', 'docs/images/social-preview-en.png', 'docs/example.svg']).problems.length, 1)
  assert.equal(binaryImages(['docs/with space.JPG']).problems.length, 1)
  for (const text of ['Bearer synthetic01234567890123456789', 'ghp_synthetic01234567890123456789', 'github_pat_synthetic01234567890123456789', 'sk-ant-synthetic01234567890123456789', 'xoxb-synthetic0123456789', 'AKIA1234567890ABCDEF']) {
    const checked = privateData({ body: text, added: [] })
    assert.equal(checked.problems.length, 1)
    assert.equal(report(checked, text).includes(text), false)
  }
})

test('pr-check reports the last review verdict and distinguishes current and older heads', () => {
  const head = syntheticPr().head
  const comments = [{ body: 'Review: APPROVE 1234567' }, { body: `Review: REQUEST CHANGES ${head}` }]
  assert.match(verdict(comments, head).info[0], /REQUEST CHANGES.*current head/)
  assert.match(verdict(comments.slice(0, 1), head).info[0], /older head/)
  assert.match(verdict([], head).info[0], /no review verdict/)
})

test('pr-check combines issue state claims cap and draft information without mutating inputs', () => {
  const data = syntheticPr()
  const before = JSON.stringify(data)
  assert.deepEqual(checkPr(data).problems, [])
  assert.equal(JSON.stringify(data), before)
  assert.ok(checkPr({ ...data, issueData: { state: 'closed' } }).problems.some(item => item.check === 'issue'))
  assert.ok(checkPr({ ...data, issueData: { state: 'open', pull_request: {} } }).problems.some(item => item.check === 'issue'))
  assert.ok(checkPr({ ...data, issueComments: [] }).problems.some(item => item.check === 'claim'))
  assert.ok(checkPr({ ...data, isDraft: true }).info.some(line => /gh pr ready 17/.test(line)))
})

test('pr-check reads committed files rather than dirty working files and appends a safe Markdown summary', async t => {
  const setup = fixture(t)
  setup.put('CHANGELOG.md', 'not the committed changelog')
  setup.put('tests/x.test.mjs', 'not the committed tests')
  const summary = join(setup.directory, 'summary.md')
  setup.put('summary.md', 'Existing summary\n')
  const execution = await setup.run([], { GITHUB_STEP_SUMMARY: summary })
  assert.equal(execution.status, 0, execution.stdout + execution.stderr)
  assert.match(readFileSync(summary, 'utf8'), /^Existing summary\n## pr-check:/)
  assert.match(readFileSync(summary, 'utf8'), /all checks passed/)
  const unsafe = reportMarkdown({ problems: [{ check: 'synthetic', message: '<img src=x> [click](https://example.invalid)', fix: 'Use <name>' }], info: [] }, 'synthetic')
  assert.equal(unsafe.includes('<img'), false)
  assert.ok(unsafe.includes('&lt;img'))
})

test('pr-check prints each message on one line whatever line breaks the pull request text holds', () => {
  const printed = report({ problems: [{ check: 'synthetic', message: 'a\n::error::injected', fix: 'b\r\n::warning::injected' }], info: ['c\u2028::notice::injected', 'd\u0085::group::injected'] }, 'h\n::add-mask::injected')
  // The header, the failure and its fix, two info lines and the count.
  assert.equal(linesOf(printed).length, 6)
  assert.equal(linesOf(printed).some(line => line.trimStart().startsWith('::')), false)
})

test('pr-check checks CI event commits even when another branch is checked out and leaves the bundle to test.yml', t => {
  const setup = fixture(t)
  // A scripts/ change would run the pull request's own bundle code; in CI test.yml checks it instead.
  setup.put('scripts/synthetic.mjs', 'export const synthetic = true\n')
  setup.git('add', '--', 'scripts/synthetic.mjs')
  setup.git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix: synthetic script')
  const head = setup.git('rev-parse', 'HEAD')
  setup.put('event.json', JSON.stringify({ repository: { full_name: 'synthetic/example' }, pull_request: { number: 17, title: 'fix: synthetic check', body, draft: true, created_at: '2030-01-01T00:00:00Z', labels: [], head: { ref: branch, sha: head }, base: { sha: setup.base } } }))
  setup.git('switch', 'main')
  // The one run through the command line: it proves the entry point and what GitHub Actions reads.
  const execution = spawnSync(process.execPath, [script, '--event', join(setup.directory, 'event.json'), '--repo-dir', setup.directory, '--offline'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } })
  assert.equal(execution.status, 0, execution.stdout + execution.stderr)
  assert.match(execution.stdout, /#17 fix\/synthetic-check/)
  assert.match(execution.stdout, /info draft:/)
  assert.match(execution.stdout, /info bundle: checked by test\.yml/)
  assert.match(execution.stdout, /^::stop-commands::([0-9a-f]{32})\r?\n[\s\S]*\r?\n::\1::\r?\n$/)
})

test('pr-check leaves the bundle to CI in a checkout that converts line endings', async t => {
  const setup = fixture(t)
  setup.put('scripts/synthetic.mjs', 'export const synthetic = true\n')
  setup.git('add', '--', 'scripts/synthetic.mjs')
  setup.git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fix: synthetic script')
  // What a checkout with core.autocrlf=true leaves on disk.
  setup.put('hooks/board-script.ts', ['// Synthetic bundle', 'export const BOARD_SCRIPT = ""', ''].join('\r\n'))
  const execution = await runMain(['--body-file', join(setup.directory, 'body.txt'), '--title', 'fix: synthetic check', '--base', setup.base, '--repo-dir', setup.directory, '--offline'])
  assert.equal(execution.status, 0, execution.stdout + execution.stderr)
  assert.match(execution.stdout, /info bundle not checked: hooks\/board-script\.ts has CRLF line endings/)
})

test('pr-check reads gh API lists line by line and reports a missing issue as missing, not as a network error', async () => {
  const calls = []
  const answers = {
    'repos/synthetic/example/issues/42': { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' },
    'repos/synthetic/example/issues/43': { status: 1, stdout: '', stderr: 'gh: This issue was deleted (HTTP 410)\n' },
    'repos/synthetic/example/issues/44': { status: 1, stdout: '', stderr: 'gh: Server Error (HTTP 500)\n' },
    'repos/synthetic/example/pulls?state=open&per_page=100': { status: 0, stdout: '{"number":1}\n{"number":2}\n', stderr: '' },
  }
  const run = (program, args) => {
    calls.push([program, ...args])
    return answers[args.at(-1)] ?? { status: 1, stdout: '', stderr: 'gh: synthetic-secret detail' }
  }
  const api = apiReader({}, 'synthetic/example', '.', run)
  assert.equal(await api('issues/42', { isMissingAllowed: true }), false)
  assert.equal(await api('issues/43', { isMissingAllowed: true }), false)
  await assert.rejects(api('issues/44', { isMissingAllowed: true }), /network check failed for repos\/synthetic\/example\/issues\/44; --offline/)
  await assert.rejects(api('issues/42'), /network check failed/)
  assert.deepEqual(await api('pulls?state=open', { isList: true }), [{ number: 1 }, { number: 2 }])
  assert.deepEqual(calls.at(-1), ['gh', 'api', '--paginate', '--jq', '.[] | tojson', 'repos/synthetic/example/pulls?state=open&per_page=100'])
  await assert.rejects(api('issues/45'), error => !error.message.includes('synthetic-secret'))
})

test('pr-check prints usage and returns environment errors without exposing input secrets', async t => {
  const setup = fixture(t)
  const help = await runMain(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  for (const args of [[], ['--pr', 'no'], ['--body-file', 'missing'], ['--event', 'missing'], ['--pr', '1', '--event', 'file'], ['--body', 'synthetic-secret'], ['--offline', '--offline']]) {
    const execution = await runMain(args)
    assert.equal(execution.status, 2, JSON.stringify(args))
    assert.match(execution.stderr, /pr-check:/)
    assert.equal(execution.stderr.includes('synthetic-secret'), false)
  }
  setup.put('bad.json', '{invalid synthetic data')
  assert.equal((await runMain(['--event', join(setup.directory, 'bad.json')])).status, 2)
  const summaryFailure = await setup.run([], { GITHUB_STEP_SUMMARY: setup.directory })
  assert.equal(summaryFailure.status, 2)
  assert.match(summaryFailure.stderr, /could not append/)
  assert.equal(summaryFailure.stdout.includes('all checks passed'), false)
})

test('pr-check judges pictures by name and a moved file at its old path as well as its new one', async t => {
  const setup = fixture(t)
  // A .gitattributes line would make git call the picture text, so its name is what counts.
  setup.put('.gitattributes', '*.png text\n')
  setup.put('docs/synthetic.png', 'synthetic text standing in for a picture\n')
  setup.put('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- A synthetic change (#42). Tests: none (documentation only).\n\n## 1.0.0\n')
  setup.git('mv', 'tests/x.test.mjs', 'docs/x.md')
  setup.git('add', '--', '.gitattributes', 'docs/synthetic.png', 'CHANGELOG.md')
  setup.git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'docs: synthetic move')
  const execution = await setup.run()
  assert.equal(execution.status, 1, execution.stdout + execution.stderr)
  assert.match(execution.stdout, /binary image added or changed: docs\/synthetic\.png/)
  assert.match(execution.stdout, /"Tests: none" is only allowed for documentation-only changes/)
})

test('pr-check paginates CI API data and fails closed on network errors', async t => {
  const setup = fixture(t)
  const event = join(setup.directory, 'event.json')
  setup.put('event.json', JSON.stringify({ repository: { full_name: 'synthetic/example' }, pull_request: { number: 17, title: 'fix: synthetic check', body, draft: false, created_at: '2030-01-01T00:00:00Z', labels: [], head: { ref: branch, sha: setup.head }, base: { sha: setup.base } } }))
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const env = { GITHUB_API_URL: 'https://api.example.invalid', GITHUB_TOKEN: 'synthetic-token-value' }
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ host: url.host, authorization: options.headers.Authorization })
    assert.equal(options.redirect, 'error')
    assert.equal(url.searchParams.get('per_page'), '100')
    const isClaim = url.pathname.endsWith('/issues/42/comments')
    const isSecond = url.searchParams.has('page')
    const payload = isClaim ? (isSecond ? [{ body: `Claim: codex, ${branch}` }] : []) : url.pathname.endsWith('/issues/42') ? { state: 'open' } : []
    return { ok: true, status: 200, json: async () => payload, headers: new Headers(isClaim && !isSecond ? { link: '<https://api.example.invalid/repos/synthetic/example/issues/42/comments?per_page=100&page=2>; rel="next"' } : {}) }
  }
  const args = ['--event', event, '--repo-dir', setup.directory]
  const passed = await runMain(args, env)
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.equal(calls.length, 5)
  assert.ok(calls.every(call => call.host === 'api.example.invalid' && call.authorization === 'Bearer synthetic-token-value'))
  globalThis.fetch = async url => (url.pathname.endsWith('/issues/42') ? { ok: false, status: 404, headers: new Headers() } : { ok: true, status: 200, json: async () => [], headers: new Headers() })
  const missing = await runMain(args, env)
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /issue #42 does not exist/)
  assert.equal(missing.stdout.includes('FAIL claim'), false)
  globalThis.fetch = async () => { throw new Error('synthetic secret network detail') }
  const failed = await runMain(args, env)
  assert.equal(failed.status, 2)
  // --offline cannot be used in CI, so the event run says to re-run the job instead.
  assert.match(failed.stderr, /network check failed.*re-run the job/)
  assert.equal(failed.stderr.includes('synthetic secret'), false)
  calls.length = 0
  globalThis.fetch = async (url, options) => {
    calls.push({ host: url.host, authorization: options.headers.Authorization })
    return { ok: true, status: 200, json: async () => (url.pathname.endsWith('/issues/42') ? { state: 'open' } : []), headers: new Headers({ link: '<https://untrusted.invalid/?token=synthetic01234567890123456789>; rel="next"' }) }
  }
  assert.equal((await runMain(args, env)).status, 2)
  assert.equal(calls.some(call => call.host === 'untrusted.invalid'), false)
})

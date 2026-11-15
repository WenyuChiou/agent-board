import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { EN } from '../hooks/strings-en.ts'
import { liveBoardPage } from '../hooks/live-page.ts'

const closePage = async url => {
  if (!url) return
  try {
    const address = new URL(url)
    await fetch(new URL('/api/close', address), {
      method: 'POST',
      headers: { 'x-board-token': address.searchParams.get('t') ?? '', 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(100) })
      await new Promise(r => setTimeout(r, 100))
    } catch {
      break
    }
  }
}

const cleanup = async (root, urls) => {
  const list = Array.isArray(urls) ? urls : [urls]
  for (const u of list) await closePage(u)
  for (let tries = 0; tries < 40; tries++) {
    try {
      rmSync(root, { recursive: true, force: true })
      break
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

test('synthetic opener spawn error produces an understandable manual-open instruction and leaves the address usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-opener-fail-'))
  let url = null
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = (target, done) => { done(false) }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    const result = spawnSync(process.execPath, [script, '--html'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })

    assert.equal(result.status, 0, result.stderr)
    // Produces understandable manual instruction
    assert.match(result.stdout, /No browser found\. Open this address in your browser:/)
    // Leaves the address usable and parseable
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(result.stdout)
    assert.ok(match, 'the manual-open address is usable in stdout')
    url = match[0]
    // Does not falsely claim the browser window was opened
    assert.doesNotMatch(result.stdout, /Opened Agent Board/)
  } finally {
    await cleanup(root, url)
  }
})

test('opener failure in --serve outputs manual-open instruction to stderr and preserves usable address on stdout last line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-opener-serve-'))
  let url = null
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = (target, done) => { done(false) }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    const result = spawnSync(process.execPath, [script, '--serve'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })

    assert.equal(result.status, 0, result.stderr)
    // Stderr outputs the manual fallback instruction plainly
    assert.match(result.stderr, /No browser found\. Open this address in your browser:/)
    // Stdout last line must strictly be s.serveAt(url) so liveBoardPage can parse it cleanly
    const parsed = liveBoardPage(result.stdout, EN)
    assert.ok(parsed, `liveBoardPage can parse stdout:\n${result.stdout}`)
    assert.ok(parsed.url.startsWith('http://127.0.0.1:'), 'address is usable and valid')
    url = parsed.url
  } finally {
    await cleanup(root, url)
  }
})

test('a board that tried the browsers and opened none is not followed by a second try from the command that asked it (#1318)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-opener-once-'))
  let url = null
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const log = join(root, 'tried.log')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    // Every try at a browser, by the board or by the command, leaves a line.
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = (target, done) => { process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, 'tried\\n'); done(false) }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    const result = spawnSync(process.execPath, [script, '--html'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })

    assert.equal(result.status, 0, result.stderr)
    url = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(result.stdout)?.[0] ?? null
    assert.ok(url, result.stdout)
    assert.match(result.stdout, /No browser found\. Open this address in your browser:/)
    // One try, by the board: the same browsers tried again from here fail the same way, or open a
    // second window when one came up but its launcher reported an error.
    assert.equal(readFileSync(log, 'utf8'), 'tried\n')
  } finally {
    await cleanup(root, url)
  }
})

test('--no-open prints the address without starting an opener and keeps stderr clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-no-open-'))
  const urls = []
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    // If opener were called, it would throw
    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = () => { throw new Error('SHOULD_NOT_BE_CALLED') }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    // 1. In openPage (--html --no-open)
    const resultHtml = spawnSync(process.execPath, [script, '--html', '--no-open'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })
    assert.equal(resultHtml.status, 0, resultHtml.stderr)
    assert.equal(resultHtml.stderr, '')
    assert.match(resultHtml.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/)
    assert.doesNotMatch(resultHtml.stdout, /No browser found|Opened Agent Board/)
    urls.push(resultHtml.stdout.trim())

    // 2. In --serve (--serve --no-open)
    const resultServe = spawnSync(process.execPath, [script, '--serve', '--no-open'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })
    assert.equal(resultServe.status, 0, resultServe.stderr)
    assert.equal(resultServe.stderr, '')
    const parsed = liveBoardPage(resultServe.stdout, EN)
    assert.ok(parsed)
    urls.push(parsed.url)
  } finally {
    await cleanup(root, urls)
  }
})

test('a launcher that starts or exits cleanly is not represented as confirmed browser visibility until pageIsOpen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-visibility-'))
  let url = null
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    // Mock openInBrowser resolving true (simulating child process exit 0 or spawn timer)
    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = (target, done) => { done(true) }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    const result = spawnSync(process.execPath, [script, '--html'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1' },
    })
    assert.equal(result.status, 0, result.stderr)
    // When newly launched, it reports "Opened Agent Board in your browser",
    // NOT "Agent Board is already open in your browser" (which is reserved exclusively for confirmed pageIsOpen)
    assert.match(result.stdout, /Opened Agent Board in your browser/)
    assert.doesNotMatch(result.stdout, /already open in your browser/)
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(result.stdout)
    if (match) url = match[0]
  } finally {
    await cleanup(root, url)
  }
})

test('printed local addresses and tokens are synthetic or sanitized, keeping secrets out of public logs', () => {
  // Acceptance criterion 5: verify that mock/fixture test logs do not leak real host addresses or credentials
  const syntheticToken = 'synthetic-secret-token'
  const url = `http://127.0.0.1:45678/?t=${syntheticToken}`
  const sampleStdout = `${EN.serveAt(url)}\n`
  // liveBoardPage parses the target URL cleanly without requiring token disclosure in telemetry or logs
  const parsed = liveBoardPage(sampleStdout, EN)
  assert.ok(parsed)
  assert.equal(parsed.url, url)
})

test('--serve asks openInBrowser for the app window like the plain command and --html (#1345)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-serve-app-'))
  const urls = []
  try {
    const progress = join(root, 'progress.md')
    const script = join(root, 'agent-board.mjs')
    const log = join(root, 'open-calls.jsonl')
    writeFileSync(progress, '# Progress\n## Demo\n### Synthetic task\n- [ ] Task 1\n')

    const opening = BOARD_SCRIPT.indexOf('var openInBrowser =')
    const opened = BOARD_SCRIPT.indexOf('var isRegularFile =', opening)
    assert.ok(opening > 0 && opened > opening, 'locates openInBrowser')
    const mockedScript = `${BOARD_SCRIPT.slice(0, opening)}var openInBrowser = (target, done, asApp = false) => { process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ asApp: asApp === true }) + '\\n'); done(true) }\n${BOARD_SCRIPT.slice(opened)}`
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: progress, lang: 'en' })}\n${mockedScript}`)

    for (const mode of [['--serve'], ['--html'], []]) {
      const result = spawnSync(process.execPath, [script, ...mode], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, CLAUDE_PROGRESS_FILE: '', AGENT_BOARD_TEST_PID: '', NO_COLOR: '1', CI: '' },
      })
      assert.equal(result.status, 0, `${mode.join(' ') || 'plain'}: ${result.stderr}`)
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(result.stdout)
      assert.ok(match, `${mode.join(' ') || 'plain'} stdout address:\n${result.stdout}`)
      urls.push(match[0])
      await closePage(match[0])
    }

    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls, [{ asApp: true }, { asApp: true }, { asApp: true }])
  } finally {
    await cleanup(root, urls)
  }
})

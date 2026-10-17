// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const FILE = `# Progress

## api-gateway
<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=2026-10-17T08:30:00Z -->
### Rate-limit the public endpoints
- [x] Added the token bucket middleware
- [?] Per-key limit — 100 or 300 a minute?
<!-- /auto session=a1b2c3d4 -->
`

const run = (lang, args = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, FILE)
    mkdirSync(join(dir, 'progress-inbox'))
    writeFileSync(join(dir, 'progress-inbox', 'gemini-turn-1-1.json'), JSON.stringify({ session_id: 'g1', cwd: join(dir, 'docs-site'), prompt_response: 'Fixed 12 broken links.' }))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang })}\n${BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }
    return execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the board script prints the board from the file it was written for, in its language', () => {
  const text = run('en')
  assert.ok(text.startsWith('Progress  ● 1 waiting'), text)
  assert.ok(text.includes('api-gateway · codex › Rate-limit the public endpoints'), text)
  assert.ok(text.includes('docs-site · gemini: Fixed 12 broken links.'), text)
  assert.ok(run('zh-TW').startsWith('進度  ● 1 等你'))
  assert.ok(run('en', ['--lang', 'zh-CN']).startsWith('进度'))
})

test('keys played on the board tick a hand-kept step, archive a stopped block, and leave a line in the journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, `${FILE}
## Job search
### Fabrikam fellowship
- [x] Draft the statement
- [ ] Ask two referees

## docs-site
<!-- auto session=b2c3d4e5 agent=gemini state=ended updated=2026-10-16T10:00:00Z -->
### Fix the broken links
- [ ] Fix them
<!-- /auto session=b2c3d4e5 -->
`)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const play = keys => execFileSync(process.execPath, [script, '--keys', keys], { env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' }, encoding: 'utf8' })
    // The question first, then the due-free task, then the stopped block.
    const ticked = play('down x')
    assert.ok(ticked.includes('Done: “Ask two referees”.'), ticked)
    assert.ok(readFileSync(path, 'utf8').includes('- [x] Ask two referees'))
    const journal = readdirSync(dir).find(name => name.includes('-journal-'))
    assert.ok(journal && readFileSync(join(dir, journal), 'utf8').includes('Job search · Fabrikam fellowship · Ask two referees'))
    const archived = play('down a')
    assert.ok(archived.includes('Archived “Fix the broken links”.'), archived)
    assert.ok(!readFileSync(path, 'utf8').includes('b2c3d4e5'))
    const archive = readdirSync(dir).find(name => name.includes('-archive-'))
    assert.ok(archive && readFileSync(join(dir, archive), 'utf8').includes('### Fix the broken links'))
    // The other agent's block and its question are untouched.
    assert.ok(readFileSync(path, 'utf8').includes('session=a1b2c3d4 agent=codex state=waiting'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The board script `/progress connect` writes, run the way every other agent runs it: plain
// Node, no Claude Code. Needs Node 22.18+ or 24 (it reads hooks/board-script.ts directly).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

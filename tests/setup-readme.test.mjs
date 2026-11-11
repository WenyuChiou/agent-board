import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

test('the README repair preview names the apply command when an owned hook file is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'board-readme-setup-'))
  try {
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    const env = {
      [pathKey]: process.env[pathKey] ?? '',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
      HOME: home, USERPROFILE: home,
      TMPDIR: home, TMP: home, TEMP: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
      CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
      XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
      OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
      AGENT_BOARD_SETUP_COMMAND: 'npx @wenyuchiou/agent-board setup',
    }
    const run = (...args) => spawnSync(process.execPath, [resolve('scripts/setup-agent.mjs'), '--home', home, '--codex-dir', join(home, '.codex'), '--agent', 'codex', '--lang', 'en', ...args], { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const installed = run('--apply')
    assert.equal(installed.status, 0, installed.stderr)
    const hooks = join(home, '.codex', 'hooks.json')
    assert.equal(existsSync(hooks), true)
    unlinkSync(hooks)
    const snapshot = () => Object.fromEntries(readdirSync(home, { recursive: true, withFileTypes: true }).filter(one => one.isFile()).map(one => {
      const file = join(one.parentPath, one.name)
      return [file.slice(home.length), readFileSync(file).toString('base64')]
    }))
    const before = snapshot()
    const preview = run()
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /Next steps:/)
    assert.match(preview.stdout, /Apply these changes: npx @wenyuchiou\/agent-board setup.*--agent codex --apply/)
    assert.deepEqual(snapshot(), before)
    for (const [file, label, next] of [['README.md', 'Nothing changed after installing', 'Next steps'], ['README.zh-TW.md', '裝完之後什麼都沒變', '接下來的步驟'], ['README.zh-CN.md', '装完之后什么都没变', '接下来的步骤']]) {
      const row = readFileSync(file, 'utf8').split(/\r?\n/).find(line => line.startsWith(`| ${label} |`))
      assert.ok(row, file)
      assert.match(row, /npx @wenyuchiou\/agent-board(?:@next)? setup/, file)
      assert.ok(row.includes('node scripts/setup-agent.mjs'), file)
      assert.ok(row.includes(next), file)
      assert.ok(!row.includes('--json'), file)
    }
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
})

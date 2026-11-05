import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const source = readFileSync(installer, 'utf8')
const start = source.indexOf('const summaries = ') + 'const summaries = '.length
const bootstrap = JSON.parse(source.slice(start, source.indexOf('\nconst summary = ', start)))
const locales = ['en', 'zh-TW', 'zh-CN']

const fixture = run => {
  const root = mkdtempSync(join(tmpdir(), 'agent-board-setup-guidance-'))
  const env = { ...process.env }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'HERMES_HOME', 'GROK_HOME', 'OPENCLAW_STATE_DIR', 'DSH_HOME', 'TMP', 'TEMP', 'TMPDIR']) {
    env[name] = join(root, name)
    mkdirSync(env[name], { recursive: true, mode: 0o700 })
  }
  env.CLAUDE_PROGRESS_FILE = join(root, 'progress.md')
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID']) delete env[name]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  const setup = (...args) => {
    const child = spawnSync(process.execPath, [installer, '--home', env.HOME, '--data-dir', join(root, 'data'), '--progress-file', env.CLAUDE_PROGRESS_FILE, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(child.status, 0, 'synthetic setup failed: ' + JSON.stringify({ status: child.status, signal: child.signal, code: child.error?.code }))
    return child.stdout
  }
  try { return run(setup) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('setup bootstrap guidance stays identical to all three canonical string tables', () => {
  const tables = ['hooks/strings-en.ts', 'hooks/i18n.ts', 'hooks/strings-zh-cn.ts'].map(file => {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    return JSON.parse(text.match(/  setupSummary: (\{[\s\S]*?\n  \}),/)[1])
  })
  assert.deepEqual(bootstrap, tables)
})

test('setup gives each hook or plugin host its own concrete next step after apply', () => {
  const hosts = { antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build', muse: 'Muse Code', gemini: 'Gemini CLI', opencode: 'OpenCode', openclaw: 'OpenClaw', deepseek: 'DeepSeek' }
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const said = setup('--agent', Object.keys(hosts).join(','), '--lang', lang, '--apply')
    for (const [host, name] of Object.entries(hosts)) {
      const step = said.split(/\r?\n/).find(line => /^\d+\. /.test(line) && line.includes(name))
      assert.ok(step, host)
      const generic = bootstrap[index].reload?.replace('{host}', name) ?? 'enable its reporting hooks or plugin'
      assert.ok(!step.includes(generic), host + ' still prints the generic enablement instruction')
      assert.equal(typeof bootstrap[index][host], 'string', host + ' has no specific guidance')
      assert.ok(said.includes(bootstrap[index][host]), host + ' guidance was not printed')
    }
  })
})

test('the Antigravity apply summary accounts for every file counted by its preview', () => {
  for (const lang of locales) for (const targets of ['cursor,antigravity', 'antigravity,cursor']) fixture(setup => {
    const args = ['--agent', targets, '--lang', lang]
    const preview = setup(...args)
    const applied = setup(...args, '--apply')
    const counts = text => text.split(/\r?\n/).find(line => line.startsWith('Antigravity:')).match(/\d+/g)?.map(Number) ?? []
    const before = counts(preview)
    const after = counts(applied)
    assert.equal(before.length, 1)
    assert.ok(before[0] > 0)
    assert.equal(after.reduce((sum, n) => sum + n, 0), before[0], 'Antigravity preview/apply lost the files another selected agent already updated')
    const repeated = setup(...args)
    assert.ok(repeated.split(/\r?\n/).find(line => line.startsWith('Antigravity:')).includes(bootstrap[locales.indexOf(lang)].ready))
  })
})

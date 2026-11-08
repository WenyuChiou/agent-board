import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
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
  env.AGENT_BOARD_SETUP_COMMAND = ''
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID']) delete env[name]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  const runCommand = (file, prefix, args) => {
    const child = spawnSync(process.execPath, [file, ...prefix, '--home', env.HOME, '--data-dir', join(root, 'data'), '--progress-file', env.CLAUDE_PROGRESS_FILE, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(child.status, 0, 'synthetic setup failed: ' + JSON.stringify({ status: child.status, signal: child.signal, code: child.error?.code }))
    return child.stdout
  }
  const setup = (...args) => runCommand(installer, [], args)
  const launch = (...args) => runCommand(launcher, ['setup'], args)
  try { return run(setup, { launch, env, root }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('setup bootstrap guidance stays identical to all three canonical string tables', () => {
  const tables = ['hooks/strings-en.ts', 'hooks/i18n.ts', 'hooks/strings-zh-cn.ts'].map(file => {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    return JSON.parse(text.match(/  setupSummary: (\{[\s\S]*?\n  \}),/)[1])
  })
  assert.deepEqual(bootstrap, tables)
})

test('setup groups new sessions while retaining plugin restart instructions', () => {
  const hosts = { antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build', muse: 'Muse Code', gemini: 'Gemini CLI', opencode: 'OpenCode', openclaw: 'OpenClaw', deepseek: 'DeepSeek' }
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const said = setup('--agent', Object.keys(hosts).join(','), '--lang', lang, '--apply')
    const start = bootstrap[index].start.replace('{agents}', Object.values(hosts).join(lang === 'en' ? ', ' : '、'))
    assert.equal(said.split(start).length - 1, 1)
    for (const host of ['opencode', 'openclaw', 'deepseek']) assert.ok(said.includes(bootstrap[index][host]), host)
  })
})

test('npm setup groups shared files, accurate counts, commands and sessions in every language', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, { launch, env, root }) => {
    const bin = join(root, 'synthetic bin')
    mkdirSync(bin)
    const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    writeFileSync(codex, 'synthetic', { mode: 0o755 })
    env.PATH = [bin, env.PATH].join(delimiter)
    const args = ['--agent', 'codex,hermes', '--lang', lang]
    const direct = setup(...args)
    assert.ok(direct.includes(process.execPath), direct)
    assert.doesNotMatch(direct, /npx @wenyuchiou\/agent-board/)
    const plans = JSON.parse(launch(...args, '--json')).plans
    assert.deepEqual(plans, JSON.parse(setup(...args, '--json')).plans)
    const common = new Set(plans[0].changes.map(change => change.file).filter(file => plans[1].changes.some(change => change.file === file)))
    assert.ok(common.size >= 4)
    const text = launch(...args)
    const lines = text.split(/\r?\n/)
    assert.ok(lines[0].startsWith(`${bootstrap[index].shared}:`), text)
    for (const file of common) {
      const shown = file.startsWith(`${env.HOME}/`) || file.startsWith(`${env.HOME}\\`) ? `~${file.slice(env.HOME.length)}` : file
      assert.equal(lines.filter(line => line === `  ${shown}`).length, 1, text)
      assert.ok(lines.slice(1, common.size + 1).includes(`  ${shown}`), text)
    }
    const ownCounts = []
    for (const [i, name] of ['Codex', 'Hermes Agent'].entries()) {
      const own = plans[i].changes.filter(change => !common.has(change.file))
      assert.ok(own.length > 0 && own.every(change => change.action === 'create'))
      ownCounts.push(own.length)
      const status = bootstrap[index].previewCreate.replace('{count}', own.length)
      assert.ok(lines.includes(`${name}: ${status}`), text)
    }
    const start = bootstrap[index].start.replace('{agents}', ['Codex', 'Hermes Agent'].join(lang === 'en' ? ', ' : '、'))
    const applied = launch(...args, '--apply')
    for (const [i, name] of ['Codex', 'Hermes Agent'].entries()) {
      const status = bootstrap[index].applied.replace('{count}', ownCounts[i])
      assert.ok(applied.split(/\r?\n/).includes(`${name}: ${status}`), applied)
    }
    assert.ok(applied.includes(`${bootstrap[index].shared}: ${bootstrap[index].applied.replace('{count}', common.size)}`), applied)
    for (const output of [text, applied]) {
      assert.equal(output.split(start).length - 1, 1, output)
      assert.match(output, /npx @wenyuchiou\/agent-board --codex-trust --codex-bin /)
      assert.match(output, /npx @wenyuchiou\/agent-board --hermes-trust/)
      assert.ok(output.includes(bootstrap[index].board.replace('{command}', 'npx @wenyuchiou/agent-board')))
      assert.doesNotMatch(output, /& '/)
      assert.ok(!output.includes(process.execPath), output)
    }
    const repeated = launch(...args)
    for (const name of ['Codex', 'Hermes Agent']) assert.ok(repeated.includes(`${name}: ${bootstrap[index].ready}`), repeated)
  })
})

test('setup separates newly created and updated files in its preview', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, { env }) => {
    writeFileSync(join(env.CODEX_HOME, 'hooks.json'), '{"hooks":{},"synthetic":true}\n')
    const args = ['--agent', 'codex', '--lang', lang]
    const plan = JSON.parse(setup(...args, '--json')).plans[0]
    const created = plan.changes.filter(change => change.action === 'create').length
    const updated = plan.changes.filter(change => change.action === 'update').length
    assert.ok(created > 0 && updated > 0)
    const line = setup(...args).split(/\r?\n/)[0]
    assert.ok(line.includes(bootstrap[index].previewCreate.replace('{count}', created)), line)
    assert.ok(line.includes(bootstrap[index].preview.replace('{count}', updated)), line)
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
    assert.ok(repeated.split(/\r?\n/).find(line => line.startsWith('Antigravity:')).includes(bootstrap[locales.indexOf(lang)].ready), repeated)
  })
})

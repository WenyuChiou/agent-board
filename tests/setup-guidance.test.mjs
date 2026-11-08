import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setupPrograms } from './helpers/setup-programs.mjs'

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
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_BOARD_AGENT', 'AGENT_BOARD_SESSION_ID', 'AGENT_BOARD_SETUP_TTY', 'AGENT_BOARD_TEST_CODEX_FAIL', 'AGENT_BOARD_TEST_CLAUDE_FAIL']) delete env[name]
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'])].join(delimiter)
  const invoke = (file, prefix, args, input) => spawnSync(process.execPath, [file, ...prefix, '--home', env.HOME, '--data-dir', join(root, 'data'), '--progress-file', env.CLAUDE_PROGRESS_FILE, ...args], { env, input, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  const runCommand = (file, prefix, args) => {
    const child = invoke(file, prefix, args)
    assert.equal(child.status, 0, 'synthetic setup failed: ' + JSON.stringify({ status: child.status, signal: child.signal, code: child.error?.code }))
    return child.stdout
  }
  const setup = (...args) => runCommand(installer, [], args)
  const launch = (...args) => runCommand(launcher, ['setup'], args)
  try { return run(setup, { launch, env, root, invoke: (args, input = '\n') => invoke(installer, [], args, input) }) } finally { rmSync(root, { recursive: true, force: true }) }
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

test('setup with one agent asks for one new session, without "each of"', () => {
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const said = setup('--agent', 'hermes', '--lang', lang)
    assert.ok(said.includes(bootstrap[index].startOne.replace('{agents}', 'Hermes Agent')), said)
    assert.ok(!said.includes(bootstrap[index].start.replace('{agents}', 'Hermes Agent')), said)
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

const terminal = (run, programs) => fixture((setup, f) => {
  f.env.USERPROFILE = f.env.HOME
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  f.env.AGENT_BOARD_TEST_PID = String(process.pid)
  const commands = setupPrograms(f.root, f.env, programs)
  return run({ ...f, commands })
})
const succeeded = result => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
}
const claudeCalls = f => f.commands.calls().filter(call => call.program === 'claude').map(call => call.args)
const pluginCommands = [['plugin', 'marketplace', 'add', 'WenyuChiou/agent-board'], ['plugin', 'install', 'agent-board@agent-board']]
const assertTrusted = f => {
  const calls = f.commands.calls().filter(call => call.method === 'config/batchWrite')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.edits[0].keyPath, 'hooks.state')
  assert.equal(Object.keys(calls[0].params.edits[0].value).length, 7)
  assert.equal((readFileSync(join(f.env.CODEX_HOME, 'config.toml'), 'utf8').match(/trusted_hash/g) ?? []).length, 7)
  const approvals = JSON.parse(readFileSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json'), 'utf8')).approvals
  const owned = JSON.parse(readFileSync(join(f.root, 'data', 'install-hermes.json'), 'utf8')).groups.hooks
  assert.deepEqual(approvals.map(({ event, command }) => [event, command]), Object.entries(owned))
}

test('terminal setup accepts one yes for files, Codex and Hermes trust, and both Claude plugin commands', () => terminal(f => {
  const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'], 'yes\n')
  succeeded(result)
  assert.equal(result.stdout.split('Set these up? [Y/n]').length - 1, 1)
  assert.match(result.stdout, /This will:[\s\S]*Approve the board's hooks in Codex[\s\S]*Approve the board's hooks in Hermes Agent[\s\S]*Install the Claude Code plugin/)
  assert.match(result.stdout, /Codex files: done\./)
  assert.match(result.stdout, /Hermes Agent files: done\./)
  assertTrusted(f)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  const next = result.stdout.split('Next steps:')[1]
  assert.match(next, /1\. Open a new session in each of: Codex, Hermes Agent, Claude Code\./)
  assert.match(next, /2\. Then type \/agent-board in any of them\./)
  assert.doesNotMatch(next, /--trust|--codex-trust|--hermes-trust|claude plugin/)
}))

test('terminal Enter means yes and the question is translated in all three languages', () => {
  for (const [i, lang] of locales.entries()) terminal(f => {
    const result = f.invoke(['--agent', 'cursor', '--lang', lang])
    succeeded(result)
    assert.ok(result.stdout.includes(bootstrap[i].question))
    assert.equal(existsSync(join(f.root, 'data', 'install-cursor.json')), true)
    assert.deepEqual(claudeCalls(f), pluginCommands)
  })
})

test('terminal setup --apply writes files only and leaves hook approval and the plugin to a typed yes', () => terminal(f => {
  const result = f.invoke(['--agent', 'codex,hermes,opencode,openclaw', '--lang', 'en', '--apply'], 'y\n')
  succeeded(result)
  assert.doesNotMatch(result.stdout, /Set these up\?|This will:/)
  assert.equal(existsSync(join(f.root, 'data', 'install-codex.json')), true)
  assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), false)
  assert.equal(f.commands.calls().some(call => call.method === 'config/batchWrite'), false)
  assert.deepEqual(claudeCalls(f), [])
  const next = result.stdout.split('Next steps:')[1]
  assert.match(next, /--codex-trust --codex-bin/)
  assert.match(next, /--hermes-trust/)
  assert.match(next, /claude plugin install agent-board@agent-board/)
  for (const host of ['opencode', 'openclaw']) assert.ok(next.includes(bootstrap[0][host]))
}))

test('terminal setup skips "marketplace add" when Claude Code already knows the marketplace', () => terminal(f => {
  mkdirSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true })
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'agent-board': { source: { source: 'github', repo: 'WenyuChiou/agent-board' } } }))
  const result = f.invoke(['--agent', 'cursor', '--lang', 'en'], 'y\n')
  succeeded(result)
  assert.deepEqual(claudeCalls(f), [pluginCommands[1]])
  assert.doesNotMatch(result.stdout, /Claude Code marketplace:/)
  assert.match(result.stdout, /Claude Code plugin: done\./)
}))

test('a Claude plugin install that exits 0 without installing the plugin is reported as failed', () => terminal(f => {
  f.env.AGENT_BOARD_TEST_CLAUDE_FAIL = 'silent'
  const result = f.invoke(['--agent', 'cursor', '--lang', 'en'], 'y\n')
  succeeded(result)
  assert.match(result.stdout, /Claude Code plugin: failed\. Run: claude plugin install agent-board@agent-board/)
  assert.doesNotMatch(result.stdout.split('Next steps:')[1] ?? '', /Claude Code/)
}))

test('an agent whose files fail reports its hook approval as not done, with the command to run', () => terminal(f => {
  // The preload makes only the Codex file write fail; the preview and Hermes Agent are untouched.
  const preload = join(f.root, 'fail-codex-apply.cjs')
  writeFileSync(preload, "const a = process.argv; if ((a[1] || '').endsWith('setup-codex.mjs') && a.includes('--apply') && a[a.indexOf('--agent') + 1] === 'codex') { process.stderr.write(JSON.stringify({ error: { code: 'SYNTHETIC', message: 'synthetic write failure' } }) + '\\n'); process.exit(2) }\n")
  f.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'], 'y\n')
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /Codex files: failed\./)
  assert.match(result.stdout, /Approve the board's hooks in Codex: failed\. Run: .*--codex-trust/)
  assert.match(result.stdout, /Approve the board's hooks in Hermes Agent: done\./)
  assert.equal(f.commands.calls().some(call => call.method === 'config/batchWrite'), false)
}))

test('a failed Claude plugin part keeps files and both trust applies and does not skip the other plugin command', () => {
  for (const failure of ['marketplace', 'install', 'all']) terminal(f => {
    f.env.AGENT_BOARD_TEST_CLAUDE_FAIL = failure
    const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'])
    succeeded(result)
    assertTrusted(f)
    assert.deepEqual(claudeCalls(f), pluginCommands)
    if (failure !== 'install') assert.match(result.stdout, /Claude Code marketplace: failed\. Run: claude plugin marketplace add WenyuChiou\/agent-board/)
    if (failure !== 'marketplace') assert.match(result.stdout, /Claude Code plugin: failed\. Run: claude plugin install agent-board@agent-board/)
    assert.match(result.stdout, /Codex files: done\./)
    assert.match(result.stdout, /Hermes Agent files: done\./)
  })
})

test('a failed Codex trust part keeps Hermes trust and the Claude plugin installation', () => terminal(f => {
  f.env.AGENT_BOARD_TEST_CODEX_FAIL = '1'
  const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'])
  succeeded(result)
  assert.match(result.stdout, /Approve the board's hooks in Codex: failed\. Run: .*--codex-trust.*--codex-bin.*--apply/)
  assert.match(result.stdout, /Approve the board's hooks in Hermes Agent: done\./)
  assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), true)
  assert.deepEqual(claudeCalls(f), pluginCommands)
}))

test('a conflicting agent is skipped once, with its retry command, while the other agent and plugin parts still finish', () => terminal(f => {
  writeFileSync(join(f.env.CODEX_HOME, 'hooks.json'), 'synthetic conflicting file')
  const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'])
  assert.ifError(result.error)
  // As without a terminal, setup exits nonzero only when every selected agent is skipped.
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Codex: skipped: .*--agent codex --apply/)
  assert.doesNotMatch(result.stdout, /Codex files:/)
  assert.equal(readFileSync(join(f.env.CODEX_HOME, 'hooks.json'), 'utf8'), 'synthetic conflicting file')
  assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), true)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  assert.equal(f.commands.calls().some(call => call.program === 'codex'), false)
}))

test('terminal no and end of input write nothing and retain the manual apply step', () => {
  for (const answer of ['n\n', '']) terminal(f => {
    const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'], answer)
    succeeded(result)
    assert.match(result.stdout, /Apply these changes: .*--apply/)
    assert.equal(existsSync(join(f.root, 'data')), false)
    assert.equal(existsSync(join(f.env.CODEX_HOME, 'hooks.json')), false)
    assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), false)
    assert.equal(existsSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins')), false)
    assert.deepEqual(f.commands.calls(), [])
  })
})

test('piped setup previews and applies only files while retaining manual trust and plugin guidance', () => terminal(f => {
  delete f.env.AGENT_BOARD_SETUP_TTY
  const preview = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'])
  succeeded(preview)
  assert.doesNotMatch(preview.stdout, /Set these up\?|This will:/)
  assert.equal(existsSync(join(f.root, 'data')), false)
  const applied = f.invoke(['--agent', 'codex,hermes', '--lang', 'en', '--apply'])
  succeeded(applied)
  assert.match(applied.stdout, /--codex-trust --codex-bin/)
  assert.match(applied.stdout, /--hermes-trust/)
  assert.match(applied.stdout, /claude plugin install agent-board@agent-board/)
  assert.equal(existsSync(join(f.root, 'data', 'install-codex.json')), true)
  assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), false)
  assert.deepEqual(f.commands.calls(), [])
}))

test('JSON setup ignores the terminal test seam and applies files without trust or plugin commands', () => terminal(f => {
  for (const extra of [[], ['--apply']]) {
    const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en', '--json', ...extra])
    succeeded(result)
    assert.equal(JSON.parse(result.stdout).applied, extra.length > 0)
    assert.equal(existsSync(join(f.root, 'data', 'install-codex.json')), extra.length > 0)
    assert.equal(existsSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json')), false)
    assert.deepEqual(f.commands.calls(), [])
  }
}))

test('an unchanged terminal setup asks nothing and repeats no approval or installation that already succeeded', () => terminal(f => {
  const args = ['--agent', 'codex,hermes', '--lang', 'en']
  succeeded(f.invoke(args, 'y\n'))
  assertTrusted(f)
  f.commands.clear()
  const result = f.invoke(args, 'y\n')
  succeeded(result)
  assert.doesNotMatch(result.stdout, /Set these up\?|Approve the board's hooks|Install the Claude Code plugin|failed/)
  assert.equal(f.commands.calls().some(call => call.method === 'config/batchWrite'), false)
  assert.deepEqual(claudeCalls(f), [])
}))

test('terminal setup installs the plugin when only Claude Code is present', () => terminal(f => {
  for (const name of ['CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCLAW_STATE_DIR', 'DSH_HOME']) rmSync(f.env[name], { recursive: true, force: true })
  const result = f.invoke(['--lang', 'en'])
  succeeded(result)
  assert.match(result.stdout, /Install the Claude Code plugin/)
  assert.match(result.stdout, /Open a new session in Claude Code\.\r?\n\d\. Then type \/agent-board there\./)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  assert.equal(existsSync(join(f.root, 'data')), false)
}, ['claude']))

test('on Windows setup says to start cursor-agent from PowerShell, in its preview and after a yes, in every language (#1159)', () => {
  const isWindows = process.platform === 'win32'
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const preview = setup('--agent', 'cursor', '--lang', lang)
    assert.equal(preview.includes(bootstrap[index].cursorWindows), isWindows, preview)
  })
  terminal(f => {
    const result = f.invoke(['--agent', 'cursor', '--lang', 'en'], 'y\n')
    succeeded(result)
    assert.equal(result.stdout.split('Next steps:')[1]?.includes(bootstrap[0].cursorWindows), isWindows, result.stdout)
  })
})

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, terminal, succeeded, claudeCalls, pluginCommands, assertTrusted } from './helpers/setup-fixture.mjs'

// These behavioral cases retain fresh homes and the real setup command for every run.
// They have their own CI file budget, away from the multi-language output/count cases (#1231).
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

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  // Each agent is named with its own way to open the board: Codex by $agent-board, Hermes Agent by its skill.
  assert.match(next, /2\. Then type \/agent-board in Claude Code\.\n3\. In Codex, type \$agent-board\.\n4\. In Hermes Agent, ask it to run the Agent Board skill\./)
  assert.doesNotMatch(next, /in any of them/)
  assert.doesNotMatch(next, /--trust|--codex-trust|--hermes-trust|claude plugin/)
}))

// The home as 0.24.2 left it for these agents, with an older board script: OpenCode has /board, not /agent-board.
// `board` is the /board file, or null when the person deleted it; `isEdited` says whether the person edited the script.
const olderScript = '// synthetic older board script\n', oldCommand = 'Synthetic /board command of an earlier version\n'
const olderHome = (f, agents, { board = oldCommand, isEdited = true } = {}) => {
  delete f.env.AGENT_BOARD_SETUP_TTY
  succeeded(f.invoke(['--agent', agents.join(','), '--lang', 'en', '--apply']))
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  const data = join(f.root, 'data'), script = join(data, 'agent-board.mjs'), commands = join(f.env.OPENCODE_CONFIG_DIR, 'commands')
  const digest = text => createHash('sha256').update(text).digest('hex')
  for (const agent of agents) {
    const file = join(data, `install-${agent}.json`), record = JSON.parse(readFileSync(file, 'utf8'))
    record.files[script] = digest(olderScript)
    if (agent === 'opencode') {
      delete record.files[join(commands, 'agent-board.md')]
      record.files[join(commands, 'board.md')] = digest(oldCommand)
    }
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  }
  if (agents.includes('opencode')) {
    rmSync(join(commands, 'agent-board.md'))
    if (board !== null) writeFileSync(join(commands, 'board.md'), board)
  }
  writeFileSync(script, isEdited ? `${olderScript}// synthetic line the person added\n` : olderScript)
  return { script, commands }
}
// The board skill an agent reads: Hermes Agent's and OpenClaw's own, else the shared one.
const skillOf = (f, agent) => join(agent === 'hermes' ? f.env.HERMES_HOME : agent === 'openclaw' ? f.env.OPENCLAW_STATE_DIR : join(f.env.HOME, '.agents'), 'skills', 'agent-board', 'SKILL.md')
// Runs setup and answers yes, with `change` (Node code, `fs` in scope) done once as setup reads the answer.
const invokeChanging = (f, args, change) => {
  const preload = join(f.root, 'change-on-answer.cjs'), mark = join(f.root, 'changed')
  writeFileSync(preload, `const fs = require('node:fs')\nconst read = fs.readSync\nfs.readSync = (fd, ...rest) => {\n  if (fd === 0 && !fs.existsSync(${JSON.stringify(mark)})) { fs.writeFileSync(${JSON.stringify(mark)}, ''); ${change} }\n  return read(fd, ...rest)\n}\nrequire('node:module').syncBuiltinESMExports()\n`)
  f.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let result
  try { result = f.invoke(args, 'yes\n') } finally { delete f.env.NODE_OPTIONS }
  assert.ok(existsSync(mark), 'setup read the answer')
  return result
}

test('setup\'s next steps name /board, not /agent-board, for an agent whose command waits (#1698)', () => terminal(f => {
  const { commands } = olderHome(f, ['opencode', 'cursor'])
  const result = f.invoke(['--agent', 'opencode,cursor', '--lang', 'en'], 'yes\n')
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.match(next, /Then type \/agent-board in Claude Code\./, result.stdout)
  assert.match(next, /In OpenCode, type \/board\. \/agent-board comes once you move your edited agent-board\.mjs aside and run setup again\./, result.stdout)
  // Cursor has no command: it gets the board command for a terminal.
  assert.match(next, /For Cursor, open the board from a terminal with \S/, result.stdout)
  assert.doesNotMatch(next, /in any of them|\/agent-board in [^\n]*Cursor/)
  assert.equal(existsSync(join(commands, 'agent-board.md')), false)
  assert.equal(readFileSync(join(commands, 'board.md'), 'utf8'), oldCommand)
}))

test('setup\'s next steps give the board command for a terminal, not /board, when the /board file is gone and /agent-board waits (#1698)', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    const { commands } = olderHome(f, ['opencode', 'cursor'], { board: null })
    const result = f.invoke(['--agent', 'opencode,cursor', '--lang', lang], 'yes\n')
    succeeded(result)
    const words = bootstrap[index], next = result.stdout.split(words.next)[1] ?? ''
    // One line gives the terminal command for OpenCode, whose /board is gone, and for Cursor, which has no command.
    const line = words.thenBoardTerminal.replace('{agents}', ['OpenCode', 'Cursor'].join(lang === 'en' ? ', ' : '、')).split('{command}')[0]
    assert.ok(next.includes(line), `${lang}: ${result.stdout}`)
    assert.doesNotMatch(next, /\/board(?!-)/, `${lang}: ${result.stdout}`)
    assert.equal(existsSync(join(commands, 'board.md')), false)
    assert.equal(existsSync(join(commands, 'agent-board.md')), false)
  })
})

test('setup\'s next steps follow what the apply did when the board script is edited while setup waits for the yes (#1698)', () => terminal(f => {
  const { script, commands } = olderHome(f, ['opencode', 'cursor'], { isEdited: false })
  // The person edits the board script while setup waits for the answer, after the preview planned /agent-board.
  const preload = join(f.root, 'edit-on-answer.cjs'), mark = join(f.root, 'edited')
  writeFileSync(preload, `const fs = require('node:fs')\nconst read = fs.readSync\nfs.readSync = (fd, ...rest) => {\n  if (fd === 0 && !fs.existsSync(${JSON.stringify(mark)})) { fs.writeFileSync(${JSON.stringify(mark)}, ''); fs.appendFileSync(${JSON.stringify(script)}, '// synthetic line the person added\\n') }\n  return read(fd, ...rest)\n}\nrequire('node:module').syncBuiltinESMExports()\n`)
  f.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`
  let result
  try { result = f.invoke(['--agent', 'opencode,cursor', '--lang', 'en'], 'yes\n') } finally { delete f.env.NODE_OPTIONS }
  succeeded(result)
  assert.ok(existsSync(mark), 'setup read the answer')
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.match(next, /In OpenCode, type \/board\./, result.stdout)
  assert.doesNotMatch(next, /\/agent-board in [^\n]*OpenCode/)
  assert.equal(existsSync(join(commands, 'agent-board.md')), false)
  assert.equal(readFileSync(join(commands, 'board.md'), 'utf8'), oldCommand)
}))

test('setup\'s next steps give the board command for a terminal when /board is deleted while setup waits and the agent had nothing to apply (#1698)', () => terminal(f => {
  // OpenCode's preview has nothing to do; the Claude plugin is what setup asks about.
  const { commands } = olderHome(f, ['opencode'])
  const record = join(f.root, 'data', 'install-opencode.json'), recorded = readFileSync(record, 'utf8')
  const result = invokeChanging(f, ['--agent', 'opencode', '--lang', 'en'], `fs.rmSync(${JSON.stringify(join(commands, 'board.md'))})`)
  succeeded(result)
  assert.match(result.stdout, /OpenCode files: done\./)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.doesNotMatch(next, /\/board(?!-)/, result.stdout)
  assert.match(next, /For OpenCode, open the board from a terminal with \S/, result.stdout)
  assert.equal(readFileSync(record, 'utf8'), recorded, 'nothing was written for OpenCode')
  assert.equal(existsSync(join(commands, 'agent-board.md')), false)
}))

test('setup\'s next steps give the board command for a terminal, not $agent-board or the skill, when the skill waits with an older kept script (#1698)', () => {
  // The skills the person deleted stay absent beside the older script, so neither agent is told to use one.
  terminal(f => {
    olderHome(f, ['codex', 'hermes'])
    for (const agent of ['codex', 'hermes']) rmSync(skillOf(f, agent))
    const result = f.invoke(['--agent', 'codex,hermes', '--lang', 'en'], 'yes\n')
    succeeded(result)
    const next = result.stdout.split('Next steps:')[1] ?? ''
    assert.doesNotMatch(next, /\$agent-board|Agent Board skill/, result.stdout)
    assert.match(next, /For Codex, Hermes Agent, open the board from a terminal with \S/, result.stdout)
    for (const agent of ['codex', 'hermes']) assert.equal(existsSync(skillOf(f, agent)), false, agent)
  })
  // Beside an edit of this version's script the deleted skill is written again.
  terminal(f => {
    delete f.env.AGENT_BOARD_SETUP_TTY
    succeeded(f.invoke(['--agent', 'codex', '--lang', 'en', '--apply']))
    f.env.AGENT_BOARD_SETUP_TTY = '1'
    const script = join(f.root, 'data', 'agent-board.mjs')
    writeFileSync(script, `${readFileSync(script, 'utf8')}// synthetic line the person added\n`)
    rmSync(skillOf(f, 'codex'))
    const result = f.invoke(['--agent', 'codex', '--lang', 'en'], 'yes\n')
    succeeded(result)
    assert.match(result.stdout.split('Next steps:')[1] ?? '', /In Codex, type \$agent-board\./, result.stdout)
    assert.equal(existsSync(skillOf(f, 'codex')), true)
  })
  // Beside an older script the skill setup wrote stays, and it still opens the board.
  terminal(f => {
    olderHome(f, ['codex'])
    const result = f.invoke(['--agent', 'codex', '--lang', 'en'], 'yes\n')
    succeeded(result)
    assert.match(result.stdout.split('Next steps:')[1] ?? '', /In Codex, type \$agent-board\./, result.stdout)
  })
})

test('setup\'s next steps give the board command for a terminal when the skill is deleted while setup waits and the agent had nothing to apply (#1698)', () => terminal(f => {
  succeeded(f.invoke(['--agent', 'codex', '--lang', 'en'], 'yes\n'))
  // The Claude plugin is gone again, so setup asks while Codex has nothing to apply.
  rmSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'))
  const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], `fs.rmSync(${JSON.stringify(skillOf(f, 'codex'))})`)
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.doesNotMatch(next, /\$agent-board/, result.stdout)
  assert.match(next, /For Codex, open the board from a terminal with \S/, result.stdout)
  assert.match(next, /Then type \/agent-board in Claude Code\./, result.stdout)
}))

test('setup\'s next steps give the board command for a terminal when /agent-board is deleted while setup waits and the agent had nothing to apply (#1698)', () => terminal(f => {
  delete f.env.AGENT_BOARD_SETUP_TTY
  succeeded(f.invoke(['--agent', 'opencode', '--lang', 'en', '--apply']))
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  const command = join(f.env.OPENCODE_CONFIG_DIR, 'commands', 'agent-board.md')
  const result = invokeChanging(f, ['--agent', 'opencode', '--lang', 'en'], `fs.rmSync(${JSON.stringify(command)})`)
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.doesNotMatch(next, /\/agent-board in [^\n]*OpenCode|in any of them/, result.stdout)
  assert.match(next, /For OpenCode, open the board from a terminal with \S/, result.stdout)
  assert.match(next, /Then type \/agent-board in Claude Code\./, result.stdout)
}))

test('setup\'s next steps give the board command for a terminal when a folder takes the skill\'s place while setup waits (#1698)', () => terminal(f => {
  olderHome(f, ['codex'])
  rmSync(skillOf(f, 'codex'))
  const result = invokeChanging(f, ['--agent', 'codex', '--lang', 'en'], `fs.mkdirSync(${JSON.stringify(skillOf(f, 'codex'))})`)
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.doesNotMatch(next, /\$agent-board/, result.stdout)
  assert.match(next, /For Codex, open the board from a terminal with \S/, result.stdout)
  assert.match(next, /Then type \/agent-board in Claude Code\./, result.stdout)
}))

test('setup does not say an agent\'s files are done, or name a way to open the board, when the board script is deleted while setup waits and the agent had nothing to apply (#1698)', () => {
  const check = (f, script, result) => {
    assert.equal(result.status, 1, result.stderr + result.stdout)
    assert.match(result.stdout, /OpenClaw files: failed\. Run: \S[^\n]*--agent openclaw --apply/, result.stdout)
    assert.doesNotMatch(result.stdout, /OpenClaw files: done/)
    const next = result.stdout.split('Next steps:')[1] ?? ''
    assert.doesNotMatch(next, /OpenClaw|in any of them/, result.stdout)
    assert.ok(!next.includes(script), result.stdout)
    assert.match(next, /Open a new session in Claude Code\./, result.stdout)
    assert.equal(existsSync(script), false)
  }
  // An older kept script with the skills deleted: the agent has nothing to apply, and the script goes while setup waits.
  terminal(f => {
    const { script } = olderHome(f, ['openclaw'])
    for (const agent of ['openclaw', 'codex']) rmSync(skillOf(f, agent))
    check(f, script, invokeChanging(f, ['--agent', 'openclaw', '--lang', 'en'], `fs.rmSync(${JSON.stringify(script)})`))
    // The command the line gives writes the board script and the skill again.
    delete f.env.AGENT_BOARD_SETUP_TTY
    succeeded(f.invoke(['--agent', 'openclaw', '--lang', 'en', '--apply']))
    assert.equal(existsSync(script), true)
    assert.equal(existsSync(skillOf(f, 'openclaw')), true)
  })
  // A plain install, nothing kept: the same.
  terminal(f => {
    delete f.env.AGENT_BOARD_SETUP_TTY
    succeeded(f.invoke(['--agent', 'openclaw', '--lang', 'en', '--apply']))
    f.env.AGENT_BOARD_SETUP_TTY = '1'
    const script = join(f.root, 'data', 'agent-board.mjs')
    check(f, script, invokeChanging(f, ['--agent', 'openclaw', '--lang', 'en'], `fs.rmSync(${JSON.stringify(script)})`))
  })
})

test('setup\'s next steps name /board when the /board file is put back while setup waits and the agent had nothing to apply (#1698)', () => terminal(f => {
  const { commands } = olderHome(f, ['opencode'], { board: null })
  // One apply first, so OpenCode has nothing left to apply; the Claude plugin is what setup asks about.
  delete f.env.AGENT_BOARD_SETUP_TTY
  succeeded(f.invoke(['--agent', 'opencode', '--lang', 'en', '--apply']))
  f.env.AGENT_BOARD_SETUP_TTY = '1'
  const record = join(f.root, 'data', 'install-opencode.json'), recorded = readFileSync(record, 'utf8')
  const result = invokeChanging(f, ['--agent', 'opencode', '--lang', 'en'], `fs.writeFileSync(${JSON.stringify(join(commands, 'board.md'))}, ${JSON.stringify(oldCommand)})`)
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.match(next, /In OpenCode, type \/board\./, result.stdout)
  assert.doesNotMatch(next, /For OpenCode[^\n]*open the board from a terminal/, result.stdout)
  assert.equal(readFileSync(record, 'utf8'), recorded, 'nothing was written for OpenCode')
}))

test('setup\'s next steps do not name /agent-board for an agent whose skill waits with an older kept script (#1698)', () => terminal(f => {
  olderHome(f, ['openclaw'])
  for (const agent of ['openclaw', 'codex']) rmSync(skillOf(f, agent))
  const result = f.invoke(['--agent', 'openclaw', '--lang', 'en'], 'yes\n')
  succeeded(result)
  const next = result.stdout.split('Next steps:')[1] ?? ''
  assert.match(next, /Then type \/agent-board in Claude Code\./, result.stdout)
  assert.doesNotMatch(next, /\/agent-board in [^\n]*OpenClaw|in any of them/, result.stdout)
  assert.match(next, /For OpenClaw, open the board from a terminal with \S/, result.stdout)
  assert.equal(existsSync(skillOf(f, 'openclaw')), false)
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
  assert.match(result.stdout, /Codex: skipped: /)
  assert.match(result.stdout, /Retry after fixing the conflicting files: .*--agent codex --apply/)
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

const copiedClaudeSettings = f => {
  for (const name of ['CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCLAW_STATE_DIR', 'DSH_HOME']) rmSync(f.env[name], { recursive: true, force: true })
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ enabledPlugins: { 'agent-board@agent-board': true }, synthetic: 'keep' }))
}

test('a copied Claude enable setting still asks once and installs before reporting success', () => terminal(f => {
  copiedClaudeSettings(f)
  const result = f.invoke(['--lang', 'en'])
  succeeded(result)
  assert.equal(result.stdout.split('Set these up? [Y/n]').length - 1, 1)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  assert.match(result.stdout, /Claude Code plugin: done\./)
  assert.match(result.stdout, /Open a new session in Claude Code\./)
  assert.equal(existsSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json')), true)
  assert.equal(JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).synthetic, 'keep')
  f.commands.clear()
  const repeated = f.invoke(['--lang', 'en'])
  succeeded(repeated)
  assert.doesNotMatch(repeated.stdout, /Set these up\?|Install the Claude Code plugin/)
  assert.deepEqual(claudeCalls(f), [])
}, ['claude']))

test('a copied Claude enable setting cannot make a silent plugin installation count as done', () => terminal(f => {
  copiedClaudeSettings(f)
  f.env.AGENT_BOARD_TEST_CLAUDE_FAIL = 'silent'
  const result = f.invoke(['--lang', 'en'])
  succeeded(result)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  assert.match(result.stdout, /Claude Code plugin: failed\. Run: claude plugin install agent-board@agent-board/)
  assert.doesNotMatch(result.stdout, /Claude Code plugin: done\.|Open a new session in Claude Code\./)
  assert.equal(existsSync(join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json')), false)
}, ['claude']))

const installedClaude = f => {
  copiedClaudeSettings(f)
  const directory = join(f.env.CLAUDE_CONFIG_DIR, 'plugins')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-board@agent-board': [{ scope: 'user' }] } }))
}

const disabledClaude = (f, hasReceipt = true) => {
  if (hasReceipt) installedClaude(f)
  else copiedClaudeSettings(f)
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ enabledPlugins: { 'agent-board@agent-board': false }, synthetic: 'keep' }))
}
const enableCommand = 'claude plugin enable agent-board@agent-board --scope user'
const assertDisabledGuidance = (f, result, index) => {
  succeeded(result)
  assert.ok(result.stdout.includes(enableCommand), 'a disabled plugin needs a manual enable instruction, not a ready-session claim')
  assert.ok(result.stdout.includes(bootstrap[index].enablePlugin.replace('{command}', enableCommand)))
  const settings = JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))
  assert.equal(settings.enabledPlugins['agent-board@agent-board'], false, 'setup must preserve the disabled preference')
  assert.equal(settings.synthetic, 'keep')
}

for (const [index, lang] of locales.entries()) {
  test('an installed Claude-only repeat gives session guidance instead of reinstall instructions in ' + lang, () => terminal(f => {
    installedClaude(f)
    const result = f.invoke(['--lang', lang])
    succeeded(result)
    assert.ok(!result.stdout.includes(bootstrap[index].plugin), 'the installed plugin must not be offered for installation again')
    assert.ok(result.stdout.includes(bootstrap[index].openOne.replace('{agents}', 'Claude Code')))
    assert.ok(result.stdout.includes(bootstrap[index].thenBoardOne))
    assert.deepEqual(claudeCalls(f), [])
    assert.equal(JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).synthetic, 'keep')
    assert.equal(existsSync(join(f.root, 'data')), false)
  }, ['claude']))

  test('a files-only setup keeps installed Claude out of plugin instructions in ' + lang, () => terminal(f => {
    installedClaude(f)
    const result = f.invoke(['--agent', 'grok', '--lang', lang, '--apply'])
    succeeded(result)
    assert.ok(!result.stdout.includes(bootstrap[index].plugin), 'another selected agent must not reintroduce Claude install guidance')
    const agents = ['Grok Build', 'Claude Code'].join(lang === 'en' ? ', ' : '、')
    assert.ok(result.stdout.includes(bootstrap[index].start.replace('{agents}', agents)))
    assert.deepEqual(claudeCalls(f), [], 'files-only setup must not run plugin commands')
    assert.equal(JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).synthetic, 'keep')
  }, ['claude']))

  test('a disabled installed Claude-only repeat gives manual enable guidance in ' + lang, () => terminal(f => {
    disabledClaude(f)
    const result = f.invoke(['--lang', lang])
    assertDisabledGuidance(f, result, index)
    assert.ok(!result.stdout.includes(bootstrap[index].openOne.replace('{agents}', 'Claude Code')))
    assert.doesNotMatch(result.stdout, /claude plugin install agent-board@agent-board/)
    assert.deepEqual(claudeCalls(f), [])
  }, ['claude']))

  test('a files-only setup preserves a disabled Claude preference in ' + lang, () => terminal(f => {
    disabledClaude(f)
    const result = f.invoke(['--agent', 'grok', '--lang', lang, '--apply'])
    assertDisabledGuidance(f, result, index)
    assert.ok(result.stdout.includes(bootstrap[index].startOne.replace('{agents}', 'Grok Build')))
    assert.doesNotMatch(result.stdout, /claude plugin install agent-board@agent-board/)
    assert.deepEqual(claudeCalls(f), [])
  }, ['claude']))
}

test('consenting to another agent does not report a disabled installed Claude plugin ready', () => terminal(f => {
  disabledClaude(f)
  const result = f.invoke(['--agent', 'grok', '--lang', 'en'])
  assertDisabledGuidance(f, result, 0)
  assert.match(result.stdout, /Open a new session in Grok Build\./)
  assert.doesNotMatch(result.stdout, /Open a new session in each of:.*Claude Code/)
  assert.deepEqual(claudeCalls(f), [])
}, ['claude']))

test('a successful installation with a disabled preference still requires manual enabling', () => terminal(f => {
  disabledClaude(f, false)
  const result = f.invoke(['--lang', 'en'])
  assertDisabledGuidance(f, result, 0)
  assert.deepEqual(claudeCalls(f), pluginCommands)
  assert.match(result.stdout, /Claude Code plugin: done\./)
  assert.doesNotMatch(result.stdout, /Open a new session in Claude Code\./)
}, ['claude']))

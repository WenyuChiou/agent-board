import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))

const makeEnv = home => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: process.env[pathKey] ?? '',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
    HERMES_HOME: join(home, '.hermes'),
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'),
    DSH_HOME: join(home, '.dsh'),
  }
}

test('setup-agent --remove previews and applies across all touched agents with short paths and names kept data files', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-remove-test-'))
  try {
    const env = makeEnv(home)
    const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, ...args], {
      cwd: home,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    })

    // 1. Install two agents: codex and antigravity
    const install = run('--agent', 'codex,antigravity', '--lang', 'en', '--apply')
    assert.equal(install.status, 0, install.stderr)
    const dataDir = join(home, '.agent-board')
    assert.ok(existsSync(join(dataDir, 'install-codex.json')))
    assert.ok(existsSync(join(dataDir, 'install-antigravity.json')))

    // Seed data files beside progress.md
    const dataFiles = [
      'progress-answered.json',
      'progress-questions.json',
      'progress-journal-2026-11.md',
      'progress-archive-2026-11.md',
      'progress-sessions.json',
    ]
    for (const name of dataFiles) {
      writeFileSync(join(dataDir, name), `synthetic ${name}\n`)
    }

    // 2. Preview remove: should detect all touched agents (codex and antigravity) in one run
    const preview = run('--remove', '--lang', 'en')
    if (preview.status !== 0) {
      console.error('PREVIEW STDOUT:', preview.stdout)
      console.error('PREVIEW STDERR:', preview.stderr)
      const jsonRun = run('--remove', '--lang', 'en', '--json')
      console.error('JSON STDOUT:', jsonRun.stdout)
      console.error('JSON STDERR:', jsonRun.stderr)
    }
    assert.equal(preview.status, 0, preview.stderr)

    // Must use short paths (~/...) rather than absolute home path in file listings
    const fileListing = preview.stdout.slice(0, preview.stdout.indexOf('Next steps:') > 0 ? preview.stdout.indexOf('Next steps:') : undefined)
    assert.ok(!fileListing.includes(home), `file listings should use short paths, found absolute home: ${fileListing}`)
    assert.ok(fileListing.includes('~'), `file listings should contain short path ~, got: ${fileListing}`)

    // Must show Shared files and name both agents in preview without count drift
    assert.ok(preview.stdout.includes('Shared: would remove'), preview.stdout)
    assert.ok(preview.stdout.includes('agent-board.mjs'), preview.stdout)
    assert.ok(preview.stdout.includes('Codex:'), preview.stdout)
    assert.ok(preview.stdout.includes('Antigravity:'), preview.stdout)

    // Must list what it keeps beside progress.md and explain it is user data
    assert.ok(preview.stdout.includes('progress.md'), preview.stdout)
    for (const name of dataFiles) {
      assert.ok(preview.stdout.includes(name), `preview must name kept file ${name}: ${preview.stdout}`)
    }
    assert.match(preview.stdout, /data|history/i, `preview must state that it keeps data/history: ${preview.stdout}`)

    // Must offer the apply command
    assert.match(preview.stdout, /--remove\s+--apply/, `preview must offer --remove --apply: ${preview.stdout}`)

    // 3. Apply remove: should remove files for both agents in one run
    const apply = run('--remove', '--lang', 'en', '--apply')
    assert.equal(apply.status, 0, apply.stderr)
    assert.ok(apply.stdout.includes('Shared: removed'), apply.stdout)
    assert.ok(apply.stdout.includes('The direct node command stops working; use npx @wenyuchiou/agent-board instead.'), apply.stdout)

    // install records should be gone
    assert.ok(!existsSync(join(dataDir, 'install-codex.json')), 'install-codex.json should be removed')
    assert.ok(!existsSync(join(dataDir, 'install-antigravity.json')), 'install-antigravity.json should be removed')

    // Data files beside progress.md MUST be kept
    assert.ok(existsSync(join(dataDir, 'progress.md')), 'progress.md must be kept')
    for (const name of dataFiles) {
      assert.ok(existsSync(join(dataDir, name)), `${name} must be kept`)
    }

    // 4. Repeated remove when nothing is installed
    const none = run('--remove', '--lang', 'en')
    assert.equal(none.status, 0, none.stderr)
    assert.match(none.stdout, /no installed.*to remove|already/i, none.stdout)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('setup-agent --remove supports traditional and simplified Chinese', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-remove-lang-'))
  try {
    const env = makeEnv(home)
    const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, ...args], {
      cwd: home,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    })

    const install = run('--agent', 'antigravity', '--lang', 'zh-TW', '--apply')
    assert.equal(install.status, 0, install.stderr)

    const dataDir = join(home, '.agent-board')
    writeFileSync(join(dataDir, 'progress-questions.json'), '{"records":[]}\n')

    // Traditional Chinese preview
    const tw = run('--remove', '--lang', 'zh-TW')
    assert.equal(tw.status, 0, tw.stderr)
    const twFiles = tw.stdout.slice(0, tw.stdout.indexOf('接下來：') > 0 ? tw.stdout.indexOf('接下來：') : undefined)
    assert.ok(!twFiles.includes(home), twFiles)
    assert.ok(tw.stdout.includes('Antigravity') && tw.stdout.includes('移除'), tw.stdout)
    assert.ok(tw.stdout.includes('progress-questions.json'), tw.stdout)
    assert.ok(tw.stdout.includes('--remove') && tw.stdout.includes('--apply'), tw.stdout)

    // Simplified Chinese preview
    const cn = run('--remove', '--lang', 'zh-CN')
    assert.equal(cn.status, 0, cn.stderr)
    const cnFiles = cn.stdout.slice(0, cn.stdout.indexOf('接下来：') > 0 ? cn.stdout.indexOf('接下来：') : undefined)
    assert.ok(!cnFiles.includes(home), cnFiles)
    assert.ok(cn.stdout.includes('Antigravity') && cn.stdout.includes('移除'), cn.stdout)
    assert.ok(cn.stdout.includes('progress-questions.json'), cn.stdout)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('installed agent-board.mjs supports --remove with --agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-remove-standalone-'))
  try {
    const env = makeEnv(home)
    const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, ...args], {
      cwd: home,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    })
    const install = run('--agent', 'antigravity', '--apply')
    assert.equal(install.status, 0, install.stderr)

    const boardScript = join(home, '.agent-board', 'agent-board.mjs')
    assert.ok(existsSync(boardScript), 'agent-board.mjs must exist after install')

    const standalone = spawnSync(process.execPath, [boardScript, '--remove', '--agent', 'antigravity'], {
      cwd: home,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    })
    assert.equal(standalone.status, 0, standalone.stderr)
    assert.ok(standalone.stdout.includes('antigravity') || standalone.stdout.includes('Antigravity') || standalone.stdout.includes('progress.md'), standalone.stdout)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('after removal, the commands the README and remove output point to print plain words (#1271)', () => {
  // 1. All three READMEs point to npx @wenyuchiou/agent-board rather than the direct node script
  for (const [name, expectedLang] of [['README.md', 'en'], ['README.zh-TW.md', 'zh-TW'], ['README.zh-CN.md', 'zh-CN']]) {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    assert.ok(!text.includes('agent-board.mjs'), `${name} must not point to the board script that remove deletes`)
    for (const flags of ['', ' --lan', ' --json']) {
      assert.ok(text.includes(`\`npx @wenyuchiou/agent-board${flags}\``), `${name} must point to the npx launcher: npx @wenyuchiou/agent-board${flags}`)
    }
  }

  // 2. After remove --apply, remove's output names the npx command and explains the direct command stops working
  const messages = {
    en: 'The direct node command stops working; use npx @wenyuchiou/agent-board instead.',
    'zh-TW': '直接執行的 node 指令已無法使用；請改用 npx @wenyuchiou/agent-board。',
    'zh-CN': '直接运行的 node 命令已无法使用；请改用 npx @wenyuchiou/agent-board。',
  }

  for (const [lang, expectedMessage] of Object.entries(messages)) {
    const home = mkdtempSync(join(tmpdir(), `setup-remove-words-${lang}-`))
    try {
      const env = makeEnv(home)
      const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, ...args], {
        cwd: home,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      })

      // Install codex
      const install = run('--agent', 'codex', '--lang', lang, '--apply')
      assert.equal(install.status, 0, install.stderr)

      // Apply remove with launcher environment simulating `npx @wenyuchiou/agent-board remove --apply`
      const applyWithLauncher = run('--remove', '--lang', lang, '--apply')
      assert.equal(applyWithLauncher.status, 0, applyWithLauncher.stderr)
      assert.ok(applyWithLauncher.stdout.includes(expectedMessage), `${lang} remove output must include: ${expectedMessage}, got: ${applyWithLauncher.stdout}`)
      assert.ok(!applyWithLauncher.stdout.includes('npx @wenyuchiou/agent-board remove'), `must not append remove to suggested launcher command: ${applyWithLauncher.stdout}`)

      // Also verify when AGENT_BOARD_SETUP_COMMAND is explicitly passed with remove
      const installAgain = run('--agent', 'codex', '--lang', lang, '--apply')
      assert.equal(installAgain.status, 0, installAgain.stderr)
      const launcherEnv = { ...env, AGENT_BOARD_SETUP_COMMAND: 'npx @wenyuchiou/agent-board remove' }
      const applyEnv = spawnSync(process.execPath, [installer, '--home', home, '--remove', '--lang', lang, '--apply'], {
        cwd: home,
        env: launcherEnv,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      })
      assert.equal(applyEnv.status, 0, applyEnv.stderr)
      assert.ok(applyEnv.stdout.includes(expectedMessage), `${lang} remove with AGENT_BOARD_SETUP_COMMAND must include: ${expectedMessage}, got: ${applyEnv.stdout}`)
      assert.ok(!applyEnv.stdout.includes('npx @wenyuchiou/agent-board remove'), `must not append remove to launcher command: ${applyEnv.stdout}`)

      // 3. Running the launcher (bin/agent-board.mjs) with commands from the README prints plain words, no stack trace
      const runLauncher = (...args) => spawnSync(process.execPath, [launcher, ...args], {
        cwd: home,
        env: { ...env, LANG: lang },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      })

      for (const flags of [['--lan'], ['--json'], ['--codex-doctor', '--agent', 'codex']]) {
        const result = runLauncher(...flags)
        assert.equal(result.status, 1, `launcher with ${flags.join(' ')} should exit 1 when not installed`)
        const combined = `${result.stdout}\n${result.stderr}`
        assert.ok(!combined.includes('MODULE_NOT_FOUND'), `must not contain MODULE_NOT_FOUND: ${combined}`)
        assert.ok(!combined.includes('Cannot find module'), `must not contain Cannot find module: ${combined}`)
        assert.ok(!combined.includes('at Module.'), `must not contain stack trace: ${combined}`)
        assert.ok(result.stderr.includes('npx @wenyuchiou/agent-board setup'), `must contain plain words setup hint: ${result.stderr}`)
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    }
  }
})

test('a remove that skips an agent for an edited file keeps the board script and does not say the direct command stops working (#1291)', () => {
  const home = mkdtempSync(join(tmpdir(), 'setup-remove-conflict-'))
  try {
    const env = makeEnv(home)
    const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, ...args], { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const install = run('--agent', 'codex,antigravity', '--lang', 'en', '--apply')
    assert.equal(install.status, 0, install.stderr)
    // The person edited Antigravity's skill, so its removal is skipped and the board script stays for it.
    const find = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? find(join(dir, entry.name)) : [join(dir, entry.name)])
    const skill = find(home).find(file => /gemini/.test(file) && file.endsWith('SKILL.md'))
    assert.ok(skill, 'Antigravity skill installed')
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nedited by the person\n`)
    const apply = run('--remove', '--lang', 'en', '--apply')
    assert.equal(apply.status, 0, apply.stderr)
    assert.ok(apply.stdout.includes('Antigravity: skipped'), apply.stdout)
    assert.ok(existsSync(join(home, '.agent-board', 'agent-board.mjs')), 'the board script stays for Antigravity')
    assert.ok(!apply.stdout.includes('The direct node command stops working'), apply.stdout)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

// #1244: a remove preview counts and lists files only, names a folder as going only if it is left empty, names every
// board file that stays, and a command copied from `npx … remove` says remove once.
const removeHome = (prefix, body, extraEnv = {}, agents = 'codex,cursor') => {
  const home = mkdtempSync(join(tmpdir(), prefix))
  try {
    const env = { ...makeEnv(home), ...extraEnv }
    const run = (...args) => spawnSync(process.execPath, [installer, '--home', home, '--lang', 'en', ...args], { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const install = run('--agent', agents, '--apply')
    assert.equal(install.status, 0, install.stderr)
    return body({ home, run })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
}
const succeededRun = result => {
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
// Each status line's count, by its heading (Shared, Codex, Cursor).
const countsOf = text => Object.fromEntries([...text.matchAll(/^(Shared|Codex|Cursor): (?:would remove|removed) (\d+) setup files?$/gm)].map(([, name, count]) => [name, Number(count)]))
// The paths a preview lists under each heading, up to the next heading or the kept list.
const listedOf = text => {
  const listed = {}
  let heading
  for (const line of text.split('\n')) {
    const head = line.match(/^(Shared|Codex|Cursor):/)
    if (head) { heading = head[1]; listed[heading] = []; continue }
    if (!line.startsWith('  ') || heading === undefined) { heading = undefined; continue }
    listed[heading].push(line.trim())
  }
  return listed
}
const assertFilesCounted = preview => {
  const counts = countsOf(preview), listed = listedOf(preview)
  for (const [heading, count] of Object.entries(counts)) {
    const files = listed[heading].filter(line => !line.includes('if it is left empty'))
    assert.equal(count, files.length, `${heading} counts its files only: ${preview}`)
    for (const line of files) assert.ok(!/(?:^|[\\/])(?:\.codex|\.cursor|\.agents|skills|agent-board)$/.test(line), `${heading} lists a folder as a file: ${line}\n${preview}`)
  }
}

test('a folder that gains the person\'s file between the remove preview and the apply stays, and both counts name the same files', () => removeHome('setup-remove-1244-gain-', ({ home, run }) => {
  const preview = succeededRun(run('--remove', '--agent', 'codex'))
  assert.match(preview, /~[\\/]\.codex \(the folder too, if it is left empty\)/, preview)
  writeFileSync(join(home, '.codex', 'mine.txt'), 'the person\'s own file\n')
  const apply = succeededRun(run('--remove', '--agent', 'codex', '--apply'))
  assert.equal(countsOf(apply).Codex, countsOf(preview).Codex, `${preview}\n---\n${apply}`)
  assert.ok(existsSync(join(home, '.codex', 'mine.txt')))
}))

test('removing one agent while another stays installed lists the session and message files that stay', () => removeHome('setup-remove-1244-stay-', ({ home, run }) => {
  mkdirSync(join(home, '.agent-board', 'sessions'), { recursive: true })
  writeFileSync(join(home, '.agent-board', 'sessions', 'a.json'), '{}\n')
  mkdirSync(join(home, '.cache', 'agent-board', 'x-messages'), { recursive: true })
  writeFileSync(join(home, '.cache', 'agent-board', 'x-messages', 'messages.json'), '{}\n')
  for (const output of [succeededRun(run('--remove', '--agent', 'codex')), succeededRun(run('--remove', '--agent', 'codex', '--apply'))]) {
    assert.match(output, /~[\\/]\.agent-board[\\/]sessions[\\/]a\.json/, output)
    assert.match(output, /~[\\/]\.cache[\\/]agent-board[\\/]x-messages[\\/]messages\.json/, output)
  }
  assert.ok(existsSync(join(home, '.agent-board', 'sessions', 'a.json')))
}))

test('removing the last agent counts files only and lists the message files that stay', () => removeHome('setup-remove-1244-last-', ({ home, run }) => {
  succeededRun(run('--remove', '--agent', 'codex', '--apply'))
  mkdirSync(join(home, '.cache', 'agent-board', 'x-messages'), { recursive: true })
  writeFileSync(join(home, '.cache', 'agent-board', 'x-messages', 'messages.json'), '{}\n')
  const preview = succeededRun(run('--remove', '--agent', 'cursor'))
  assertFilesCounted(preview)
  const apply = succeededRun(run('--remove', '--agent', 'cursor', '--apply'))
  assert.deepEqual(countsOf(apply), countsOf(preview), `${preview}\n---\n${apply}`)
  for (const output of [preview, apply]) assert.match(output, /~[\\/]\.cache[\\/]agent-board[\\/]x-messages[\\/]messages\.json/, output)
}))

test('a remove of two agents in one run counts each shared and own file once, with folders not counted', () => removeHome('setup-remove-1244-both-', ({ run }) => {
  const preview = succeededRun(run('--remove', '--agent', 'codex,cursor'))
  assertFilesCounted(preview)
  assert.equal((preview.match(/agents[\\/]skills[\\/]agent-board \(the folder too, if it is left empty\)/g) ?? []).length, 1, preview)
  const apply = succeededRun(run('--remove', '--agent', 'codex,cursor', '--apply'))
  assert.deepEqual(countsOf(apply), countsOf(preview), `${preview}\n---\n${apply}`)
}))

test('a remove that skips one agent prints apply and retry commands with remove once', () => removeHome('setup-remove-1244-npx-', ({ home, run }) => {
  // The person edited Antigravity's skill, so its removal is skipped, as in #1291.
  const find = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? find(join(dir, entry.name)) : [join(dir, entry.name)])
  const skill = find(home).find(file => /gemini/.test(file) && file.endsWith('SKILL.md'))
  assert.ok(skill, 'Antigravity skill installed')
  writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nedited by the person\n`)
  const preview = succeededRun(run('--remove'))
  const apply = run('--remove', '--apply')
  assert.match(apply.stdout, /Antigravity: skipped/, apply.stdout)
  const commands = [...`${preview}\n${apply.stdout}`.matchAll(/npx @wenyuchiou\/agent-board remove[^\n]*/g)].map(([line]) => line)
  assert.ok(commands.length >= 2, `${preview}\n---\n${apply.stdout}`)
  for (const line of commands) assert.ok(!line.includes('--remove'), line)
}, { AGENT_BOARD_SETUP_COMMAND: 'npx @wenyuchiou/agent-board remove' }, 'codex,antigravity'))

test('the kept list after a remove names the run cursor, page state and pane files beside progress.md', () => removeHome('setup-remove-1244-kept-', ({ home, run }) => {
  const names = ['progress-run-cursor.txt', 'progress-page-state.json', 'progress-pane.json']
  for (const name of names) writeFileSync(join(home, '.agent-board', name), 'synthetic\n')
  writeFileSync(join(home, '.agent-board', 'notes.txt'), 'not the board\'s\n')
  const apply = succeededRun(run('--remove', '--apply'))
  for (const name of names) assert.ok(apply.includes(name), `${name}: ${apply}`)
  assert.ok(!apply.includes('notes.txt'), apply)
}))

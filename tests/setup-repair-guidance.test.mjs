import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture } from './helpers/setup-fixture.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

// Keep these repair/error contracts apart from the already full setup output file.
const boardCheck = (f, args) => spawnSync(process.execPath, [join(f.root, 'data', 'agent-board.mjs'), '--home', f.env.HOME, '--data-dir', join(f.root, 'data'), '--progress-file', f.env.CLAUDE_PROGRESS_FILE, ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
const codexPaths = ['<full path to codex>', '<Codex 的完整路徑>', '<Codex 的完整路径>']

test('setup prints the whole missing-Codex trust command in every language (#1272)', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    f.env.AGENT_BOARD_SETUP_COMMAND = 'npx @wenyuchiou/agent-board setup'
    setup('--agent', 'codex', '--lang', lang, '--apply')
    const said = setup('--agent', 'codex', '--lang', lang)
    assert.match(said, /npx @wenyuchiou\/agent-board .*--codex-trust --codex-bin /)
    const command = said.split(/\r?\n/).find(line => line.includes('--codex-trust')) ?? ''
    assert.ok(command.endsWith(`--codex-bin '${codexPaths[index]}'`), 'the nonempty translated placeholder has quotes and no copied trailing punctuation')
    assert.ok(said.includes(join(f.root, 'data')), 'the command keeps this install data folder')
  })
})

test('the installed doctor prints a full trust command without Codex on PATH in every language (#1272)', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    setup('--agent', 'codex', '--lang', lang, '--apply')
    const doctor = boardCheck(f, ['--codex-doctor', '--agent', 'codex', '--lang', lang])
    assert.equal(doctor.status, 0, doctor.stderr)
    const next = doctor.stdout.split(/\r?\n/).find(line => line.includes('--codex-trust') && line.includes('node ')) ?? ''
    assert.ok(next.includes('--codex-bin'), 'the doctor supplies the complete trust entry')
    assert.ok(next.includes('agent-board.mjs') || next.includes('String.fromCodePoint'), 'the doctor names the installed command, with safe path quoting when needed')
    assert.doesNotMatch(next, /--apply/)
    assert.ok(next.endsWith(`--codex-bin "${codexPaths[index]}"`), 'each language keeps a visible, nonempty quoted placeholder')
    const commands = setupPrograms(f.root, f.env, ['codex'])
    const bin = join(f.root, 'synthetic bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const command = next.slice(next.indexOf('node ')).replace(codexPaths[index], bin.replaceAll('\\', '/'))
    const preview = spawnSync(command + ' --json', { shell: true, cwd: f.env.HOME, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(preview.status, 0, preview.stderr)
    assert.ok(JSON.parse(preview.stdout).changes > 0, 'the actual printed command, including its -- boundary, previews synthetic trust')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false, 'executing the preview does not grant trust')
  })
})

test('the installed doctor gives the missing-Codex trust step as one Next line a person can read in every language (#1800)', () => {
  const nextPrefixes = ['Next: ', '下一步：', '下一步：']
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    setup('--agent', 'codex', '--lang', lang, '--apply')
    const doctor = boardCheck(f, ['--codex-doctor', '--agent', 'codex', '--lang', lang])
    assert.equal(doctor.status, 0, doctor.stderr)
    const next = doctor.stdout.split(/\r?\n/).filter(line => line.startsWith(nextPrefixes[index]))
    assert.equal(next.length, 1, `one Next line for the one step\n${doctor.stdout}`)
    assert.ok(next[0].includes('where.exe codex') && next[0].includes('command -v codex'), `the line says how to find Codex\n${doctor.stdout}`)
    assert.ok(next[0].endsWith(`--agent codex --codex-trust --codex-bin "${codexPaths[index]}"`), `the line ends with the trust command and its placeholder\n${doctor.stdout}`)
    // On Windows a path with a backslash in the install context still takes the code-point form, as the found-Codex command does.
    if (process.platform !== 'win32') {
      assert.doesNotMatch(next[0], /fromCodePoint/, `the command is readable\n${doctor.stdout}`)
      assert.ok(next[0].includes(`node "${join(f.root, 'data', 'agent-board.mjs')}" `), `the command names the installed board script\n${doctor.stdout}`)
    }
  })
})

test('a one-agent repair leaves unrelated first-time steps out in every language (#1278)', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    const args = ['--agent', 'codex,cursor,opencode,antigravity', '--lang', lang]
    setup(...args, '--apply')
    rmSync(join(f.env.CODEX_HOME, 'hooks.json'))
    for (const extra of [[], ['--apply']]) {
      const said = setup(...args, ...extra)
      const next = said.split(bootstrap[index].next)[1] ?? ''
      assert.ok(next.includes('Codex'), 'the repaired agent retains its next step')
      for (const host of ['Cursor', 'OpenCode', 'Antigravity', 'Claude Code']) assert.ok(!next.includes(host), `unrepaired ${host} needs no first-time step`)
    }
  })
})

test('Claude setup aliases give the plugin route in every language without writing files (#1289)', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    writeFileSync(join(f.env.HOME, 'synthetic-person.txt'), 'keep me\n')
    const snapshot = () => readdirSync(f.root, { recursive: true }).sort()
    const before = snapshot()
    for (const agent of ['claude', 'claude-code']) for (const extra of [[], ['--apply'], ['--json', '--apply']]) {
      const result = f.invoke(['--agent', agent, '--lang', lang, ...extra])
      assert.notEqual(result.status, 0)
      const hint = extra.includes('--json') ? JSON.parse(result.stderr).error.message : result.stderr
      assert.ok(hint.includes(['plugin', '外掛', '插件'][index]), `${lang}: the plugin route is explained`)
      assert.ok(hint.includes('claude plugin install agent-board@agent-board'))
      assert.equal(result.stdout, '')
      assert.deepEqual(snapshot(), before)
      assert.equal(readFileSync(join(f.env.HOME, 'synthetic-person.txt'), 'utf8'), 'keep me\n')
    }
  })
})

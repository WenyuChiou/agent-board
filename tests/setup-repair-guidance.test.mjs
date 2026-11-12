import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture, terminal } from './helpers/setup-fixture.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

// Keep these repair/error contracts apart from the already full setup output file.
const boardCheck = (f, args) => spawnSync(process.execPath, [join(f.root, 'data', 'agent-board.mjs'), '--home', f.env.HOME, '--data-dir', join(f.root, 'data'), '--progress-file', f.env.CLAUDE_PROGRESS_FILE, ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })

test('setup prints the whole missing-Codex trust command in every language (#1272)', () => {
  for (const lang of locales) fixture((setup, f) => {
    f.env.PATH = ''
    f.env.AGENT_BOARD_SETUP_COMMAND = 'npx @wenyuchiou/agent-board setup'
    setup('--agent', 'codex', '--lang', lang, '--apply')
    const said = setup('--agent', 'codex', '--lang', lang)
    assert.match(said, /npx @wenyuchiou\/agent-board .*--codex-trust --codex-bin /)
    assert.ok(said.includes(join(f.root, 'data')), 'the command keeps this install data folder')
  })
})

test('the installed doctor prints a full trust command without Codex on PATH in every language (#1272)', () => {
  for (const lang of locales) fixture((setup, f) => {
    f.env.PATH = ''
    setup('--agent', 'codex', '--lang', lang, '--apply')
    const doctor = boardCheck(f, ['--codex-doctor', '--agent', 'codex', '--lang', lang])
    assert.equal(doctor.status, 0, doctor.stderr)
    const next = doctor.stdout.split(/\r?\n/).find(line => line.includes('--codex-trust') && line.includes('node ')) ?? ''
    assert.ok(next.includes('--codex-bin'), 'the doctor supplies the complete trust entry')
    assert.ok(next.includes('agent-board.mjs') || next.includes('String.fromCodePoint'), 'the doctor names the installed command, with safe path quoting when needed')
    assert.doesNotMatch(next, /--apply/)
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

test('a repaired Codex setup leaves confirmed trust alone and retains unconfirmed trust guidance (#1278)', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    const commands = setupPrograms(f.root, f.env, ['codex'])
    const args = ['--agent', 'codex', '--lang', lang]
    setup(...args, '--apply')
    const bin = join(f.root, 'synthetic bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const trust = boardCheck(f, ['--codex-trust', '--agent', 'codex', '--codex-bin', bin, '--apply'])
    assert.equal(trust.status, 0, trust.stderr)
    rmSync(join(f.env.CODEX_HOME, 'hooks.json'))
    const repaired = setup(...args, '--apply')
    assert.doesNotMatch(repaired.split(bootstrap[index].next)[1] ?? '', /--codex-trust/)
    rmSync(join(f.env.CODEX_HOME, 'hooks.json'))
    rmSync(join(f.env.CODEX_HOME, 'synthetic-trust.json'))
    const untrusted = setup(...args, '--apply')
    assert.match(untrusted.split(bootstrap[index].next)[1] ?? '', /--codex-trust/)
    assert.equal(commands.calls().filter(call => call.method === 'config/batchWrite').length, 1, 'only the explicit synthetic trust step writes trust')
  })
})

test('a terminal repair ends with only the repaired agent session steps in every language (#1278)', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    const args = ['--agent', 'codex,cursor,opencode,antigravity', '--lang', lang]
    assert.equal(f.invoke([...args, '--apply']).status, 0)
    rmSync(join(f.env.CODEX_HOME, 'hooks.json'))
    const repaired = f.invoke(args, 'y\n')
    assert.equal(repaired.status, 0, repaired.stderr)
    const next = repaired.stdout.split(bootstrap[index].next)[1] ?? ''
    assert.ok(next.includes('Codex'))
    for (const host of ['Cursor', 'OpenCode', 'Antigravity', 'Claude Code']) assert.ok(!next.includes(host), `unrepaired ${host} needs no session step`)
  }, ['codex'])
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


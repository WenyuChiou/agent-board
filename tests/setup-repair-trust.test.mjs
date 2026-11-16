import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture, terminal } from './helpers/setup-fixture.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

// Keep host-backed repair controls below the unchanged per-file CI budget.
const boardCheck = (f, args) => spawnSync(process.execPath, [join(f.root, 'data', 'agent-board.mjs'), '--home', f.env.HOME, '--data-dir', join(f.root, 'data'), '--progress-file', f.env.CLAUDE_PROGRESS_FILE, ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })

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

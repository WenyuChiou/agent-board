import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture, terminal } from './helpers/setup-fixture.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

const boardCheck = (f, args) => spawnSync(process.execPath, [join(f.root, 'data', 'agent-board.mjs'), '--home', f.env.HOME, '--data-dir', join(f.root, 'data'), '--progress-file', f.env.CLAUDE_PROGRESS_FILE, ...args], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })

test('the setup fixture removes its folder again when Windows still holds it once (#1766)', () => {
  let calls = 0
  let folder
  const removeFolder = (path, options) => {
    calls++
    if (calls === 1) throw Object.assign(new Error('synthetic busy folder'), { code: 'EPERM' })
    return rmSync(path, options)
  }
  fixture((setup, f) => { folder = f.root }, { removeFolder })
  assert.equal(calls, 2)
  assert.equal(existsSync(folder), false)
})

test('an unreachable detected Codex retains locate advice instead of a failing doctor command in every language', () => {
  for (const lang of locales) fixture((setup, f) => {
    const commands = setupPrograms(f.root, f.env, ['codex'])
    // Windows discovery accepts a native executable, not the .cmd stand-in used by explicit trust tests.
    if (process.platform === 'win32') copyFileSync(process.execPath, join(f.root, 'synthetic bin', 'codex.exe'))
    setup('--agent', 'codex', '--lang', lang, '--apply')
    f.env.AGENT_BOARD_TEST_CODEX_FAIL = '1'
    const result = boardCheck(f, ['--agent', 'codex', '--codex-doctor', '--lang', lang])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /where\.exe codex/)
    assert.equal(result.stdout.split(/\r?\n/).some(line => line.includes('node ') && line.includes('--codex-trust')), false, 'an unreachable executable is not advertised as a reached host')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false)
  })
})

test('a terminal repair reports already trusted hooks done without trusting them twice in every language', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    assert.equal(f.invoke(['--agent', 'codex', '--lang', lang, '--apply']).status, 0)
    const bin = join(f.root, 'synthetic bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const trust = boardCheck(f, ['--agent', 'codex', '--codex-trust', '--codex-bin', bin, '--apply'])
    assert.equal(trust.status, 0, trust.stderr)
    rmSync(join(f.env.CODEX_HOME, 'hooks.json'))
    f.commands.clear()
    const result = f.invoke(['--agent', 'codex', '--lang', lang], 'y\n')
    assert.equal(result.status, 0, result.stderr)
    const part = bootstrap[index].trustPart.replace('{host}', 'Codex')
    assert.ok(result.stdout.includes(bootstrap[index].partDone.replace('{part}', part)), 'every promised approval part has a completion line')
    assert.equal(f.commands.calls().some(call => call.method === 'config/batchWrite'), false, 'read-only confirmation avoids another trust write')
  }, ['codex'])
})

test('a terminal missing-Codex trust command quotes the translated path placeholder in every language', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    const result = f.invoke(['--agent', 'codex', '--lang', lang], 'y\n')
    assert.equal(result.status, 0, result.stderr)
    // No Codex program: no approval part is promised (#1801); the line naming the approval's path carries the command.
    const missing = bootstrap[index].codexMissing
    const line = result.stdout.split(/\r?\n/).find(one => one.startsWith(missing.slice(0, missing.indexOf('{')))) ?? ''
    assert.ok(line.includes(`--codex-bin '${bootstrap[index].codexPath}'`), 'the command contains a nonempty localized path protected from shell redirection')
    assert.equal(f.commands.calls().length, 0, 'no real host is reached')
  }, [])
})

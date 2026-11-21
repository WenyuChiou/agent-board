import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, fixture, locales, terminal } from './helpers/setup-fixture.mjs'
import { commandIn, runPrinted, syntheticCodex } from './helpers/setup-command-fixture.mjs'

test('a terminal missing-Codex retry keeps context once and its placeholder last in every language', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    const custom = join(f.root, 'custom Codex configuration')
    const result = f.invoke(['--agent', 'codex', '--codex-dir', custom, '--lang', lang], 'y\n')
    assert.equal(result.status, 0, result.stderr)
    const part = bootstrap[index].trustPart.replace('{host}', 'Codex')
    const line = result.stdout.split(/\r?\n/).find(one => one.startsWith(part)) ?? ''
    assert.ok(line.endsWith(`--codex-bin '${bootstrap[index].codexPath}'`))
    assert.equal((line.match(/--codex-dir/g) ?? []).length, 1)
    assert.equal((line.match(/--data-dir/g) ?? []).length, 1)
    assert.ok(line.includes('--home'))
    assert.ok(line.includes('--lang ' + lang))
    assert.equal(f.commands.calls().length, 0)
  }, [])
})

test('the installed doctor missing-Codex command runs against its explicit profile in every language', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    f.env.PATH = ''
    const custom = join(f.root, 'custom Codex configuration')
    const args = ['--home', f.env.HOME, '--data-dir', join(f.root, 'data'), '--progress-file', f.env.CLAUDE_PROGRESS_FILE, '--codex-dir', custom, '--lang', lang]
    setup('--agent', 'codex', '--codex-dir', custom, '--lang', lang, '--apply')
    const doctor = spawnSync(process.execPath, [join(f.root, 'data', 'agent-board.mjs'), ...args, '--codex-doctor'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(doctor.status, 0, doctor.stderr)
    const line = doctor.stdout.split(/\r?\n/).find(one => one.includes('node ') && one.includes('--codex-trust')) ?? ''
    const command = line.slice(line.indexOf('node '))
    assert.ok(command.endsWith(`--codex-bin "${bootstrap[index].codexPath}"`))
    const { commands, bin } = syntheticCodex(f, custom)
    const result = runPrinted(command.replace(bootstrap[index].codexPath, bin) + ' --json', f)
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).changes > 0)
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false)
  })
})

test('the printed Hermes preview keeps its explicit profile without an environment override', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    const custom = join(f.root, 'custom Hermes configuration')
    const said = setup('--agent', 'hermes', '--hermes-dir', custom, '--lang', lang, '--apply')
    const command = commandIn(said, bootstrap[index].hermes)
    assert.ok(command.includes('--hermes-dir'))
    const result = runPrinted(command, f, ['HERMES_HOME'])
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const preview = JSON.parse(result.stdout)
    assert.equal(preview.file, join(custom, 'shell-hooks-allowlist.json'))
    assert.ok(preview.changes > 0)
    assert.equal(existsSync(preview.file), false, 'the pasted preview does not grant trust')
  })
})

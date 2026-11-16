import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, fixture, locales } from './helpers/setup-fixture.mjs'
import { commandIn, runPrinted, syntheticCodex } from './helpers/setup-command-fixture.mjs'

test('the printed missing-Codex preview retains the explicit install context without host environment variables', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    const custom = join(f.root, 'custom Codex configuration')
    f.env.PATH = ''
    const args = ['--agent', 'codex', '--codex-dir', custom, '--lang', lang]
    setup(...args, '--apply')
    const said = setup(...args)
    const line = said.split(/\r?\n/).find(one => one.includes('--codex-trust')) ?? ''
    const at = line.indexOf(process.platform === 'win32' ? '& ' : process.execPath)
    assert.ok(at >= 0, 'the preview prints an installed board command')
    const { commands, bin } = syntheticCodex(f, custom)
    const config = join(custom, 'config.toml')
    writeFileSync(config, '# synthetic untrusted profile\n')
    const command = line.slice(at).replace(bootstrap[index].codexPath, bin)
    const result = runPrinted(command + ' --json', f)
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).changes > 0, 'the exact printed command previews the owned install')
    assert.equal((command.match(/--data-dir/g) ?? []).length, 1)
    assert.ok(command.includes('--home'))
    assert.ok(command.includes('--lang ' + lang))
    assert.equal(readFileSync(config, 'utf8'), '# synthetic untrusted profile\n')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false)
  })
})

test('the printed found-Codex command keeps the explicit binary and language without writing trust', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    const custom = join(f.root, 'custom Codex configuration')
    const { commands } = syntheticCodex(f, custom)
    const explicit = join(f.root, 'explicit host')
    cpSync(join(f.root, 'synthetic bin'), explicit, { recursive: true })
    const bin = join(explicit, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const args = ['--agent', 'codex', '--codex-dir', custom, '--codex-bin', bin, '--lang', lang]
    const said = setup(...args, '--apply')
    assert.equal(commands.calls().length, 0, 'the first files-only apply does not reach any host')
    const config = join(custom, 'config.toml')
    writeFileSync(config, '# untrusted custom profile\n')
    const command = commandIn(said, bootstrap[index].codex)
    assert.ok(command.includes('--codex-dir'))
    assert.ok(command.includes('explicit host'), 'the detected PATH host cannot replace an explicit binary')
    assert.equal((command.match(/--codex-bin/g) ?? []).length, 1)
    const result = runPrinted(command, f)
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(['would trust', '將信任', '将信任'][index]), 'the pasted command retains the chosen output language')
    assert.equal(readFileSync(config, 'utf8'), '# untrusted custom profile\n')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false)
  })
})

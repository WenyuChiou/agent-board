import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture, terminal } from './helpers/setup-fixture.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

// A new host is not a repair: unchanged hosts may still need explicit trust.
test('adding Cursor keeps an unchanged untrusted Codex trust step in every language', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, f) => {
    const commands = setupPrograms(f.root, f.env, ['codex'])
    setup('--agent', 'codex', '--lang', lang, '--apply')
    commands.clear()
    const said = setup('--agent', 'codex,cursor', '--lang', lang)
    assert.match(said.split(bootstrap[index].next)[1] ?? '', /--codex-trust --codex-bin /)
    assert.equal(existsSync(join(f.root, 'data', 'install-cursor.json')), false, 'preview does not install Cursor')
    assert.equal(commands.calls().some(call => call.method === 'hooks/list'), true, 'trust is checked read-only on the unchanged host')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false, 'preview never grants trust')
  })
})

test('terminal setup offers unchanged Codex trust when Cursor is new in every language', () => {
  for (const [index, lang] of locales.entries()) terminal(f => {
    assert.equal(f.invoke(['--agent', 'codex', '--lang', lang, '--apply']).status, 0)
    f.commands.clear()
    const result = f.invoke(['--agent', 'codex,cursor', '--lang', lang], 'n\n')
    assert.equal(result.status, 0, result.stderr)
    const will = result.stdout.split(bootstrap[index].thisWill)[1]?.split(bootstrap[index].question)[0] ?? ''
    assert.ok(will.includes(bootstrap[index].trustPart.replace('{host}', 'Codex')), 'the consent list retains the unchanged untrusted host')
    assert.match(result.stdout.split(bootstrap[index].next)[1] ?? '', /--codex-trust --codex-bin /)
    assert.equal(existsSync(join(f.root, 'data', 'install-cursor.json')), false, 'declining writes no Cursor installation')
    assert.equal(f.commands.calls().some(call => call.method === 'config/batchWrite'), false, 'declining grants no trust')
  }, ['codex'])
})

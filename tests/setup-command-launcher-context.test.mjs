import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { bootstrap, fixture, locales } from './helpers/setup-fixture.mjs'
import { runPrinted, syntheticCodex } from './helpers/setup-command-fixture.mjs'

const launcher = fileURLToPath(new URL('../bin/agent-board.mjs', import.meta.url))
const quote = word => `'${word.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`

test('a copied launcher trust preview selects its explicit install over a board beside progress', () => {
  for (const [index, lang] of locales.entries()) fixture((unused, f) => {
    f.env.PATH = ''
    const custom = join(f.root, 'custom Codex configuration')
    const said = f.launch('--agent', 'codex', '--codex-dir', custom, '--lang', lang, '--apply')
    const installed = readFileSync(join(f.root, 'data', 'agent-board.mjs'), 'utf8')
    const end = installed.indexOf('\n')
    const prelude = JSON.parse(installed.slice('globalThis.AGENT_BOARD = '.length, end))
    // A plugin-style board beside progress has its own root, without this Codex install's records.
    writeFileSync(join(f.root, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ ...prelude, codexRoot: f.root })}\n${installed.slice(end + 1)}`)
    const line = said.split(/\r?\n/).find(one => one.includes('--codex-trust')) ?? ''
    const prefix = 'npx @wenyuchiou/agent-board'
    const printed = line.slice(line.indexOf(prefix))
    assert.ok(printed.startsWith(prefix))
    const { commands, bin } = syntheticCodex(f, custom)
    const config = join(custom, 'config.toml')
    writeFileSync(config, '# synthetic untrusted profile\n')
    const direct = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(launcher)}`
    const result = runPrinted(printed.replace(prefix, direct).replace(bootstrap[index].codexPath, bin) + ' --json', f)
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(JSON.parse(result.stdout).changes > 0)
    assert.equal(readFileSync(config, 'utf8'), '# synthetic untrusted profile\n')
    assert.equal(commands.calls().some(call => call.method === 'config/batchWrite'), false)
  })
})

test('the launcher forwards an explicit data root once to the selected installed script', () => fixture((unused, f) => {
  const data = join(f.root, 'selected install')
  mkdirSync(data)
  writeFileSync(join(data, 'agent-board.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const result = spawnSync(process.execPath, [launcher, '--data-dir', data, '--progress-file', f.env.CLAUDE_PROGRESS_FILE, '--codex-doctor'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const argv = JSON.parse(result.stdout)
  assert.equal(argv.filter(word => word === '--data-dir').length, 1)
  assert.equal(argv[argv.indexOf('--data-dir') + 1], data)
  assert.equal(argv[argv.indexOf('--progress-file') + 1], f.env.CLAUDE_PROGRESS_FILE)
}))

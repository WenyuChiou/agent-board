import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, locales, fixture, terminal, succeeded } from './helpers/setup-fixture.mjs'

// Keep output/count contracts separate from terminal consent and failure flows (#1231).
// Every fixture still gets its own scratch home; no assertions or setup runs are shared.
test('setup bootstrap guidance stays identical to all three canonical string tables', () => {
  const tables = ['hooks/strings-en.ts', 'hooks/i18n.ts', 'hooks/strings-zh-cn.ts'].map(file => {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    return JSON.parse(text.match(/  setupSummary: (\{[\s\S]*?\n  \}),/)[1])
  })
  assert.deepEqual(bootstrap, tables)
})

test('setup groups new sessions while retaining plugin restart instructions', () => {
  const hosts = { antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build', muse: 'Muse Code', opencode: 'OpenCode', openclaw: 'OpenClaw', deepseek: 'DeepSeek' }
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const said = setup('--agent', Object.keys(hosts).join(','), '--lang', lang, '--apply')
    const start = bootstrap[index].start.replace('{agents}', Object.values(hosts).join(lang === 'en' ? ', ' : '、'))
    assert.equal(said.split(start).length - 1, 1)
    for (const host of ['opencode', 'openclaw', 'deepseek']) assert.ok(said.includes(bootstrap[index][host]), host)
  })
})

test('npm setup groups shared files, accurate counts, commands and sessions in every language', () => {
  for (const [index, lang] of locales.entries()) fixture((setup, { launch, env, root }) => {
    const bin = join(root, 'synthetic bin')
    mkdirSync(bin)
    const codex = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    writeFileSync(codex, 'synthetic', { mode: 0o755 })
    env.PATH = [bin, env.PATH].join(delimiter)
    const args = ['--agent', 'codex,hermes', '--lang', lang]
    const direct = setup(...args)
    assert.ok(direct.includes(process.execPath), direct)
    assert.doesNotMatch(direct, /npx @wenyuchiou\/agent-board/)
    const plans = JSON.parse(launch(...args, '--json')).plans
    assert.deepEqual(plans, JSON.parse(setup(...args, '--json')).plans)
    const common = new Set(plans[0].changes.map(change => change.file).filter(file => plans[1].changes.some(change => change.file === file)))
    assert.ok(common.size >= 4)
    const text = launch(...args)
    const lines = text.split(/\r?\n/)
    assert.ok(lines[0].startsWith(`${bootstrap[index].shared}:`), text)
    for (const file of common) {
      const shown = file.startsWith(`${env.HOME}/`) || file.startsWith(`${env.HOME}\\`) ? `~${file.slice(env.HOME.length)}` : file
      assert.equal(lines.filter(line => line === `  ${shown}`).length, 1, text)
      assert.ok(lines.slice(1, common.size + 1).includes(`  ${shown}`), text)
    }
    const ownCounts = []
    for (const [i, name] of ['Codex', 'Hermes Agent'].entries()) {
      const own = plans[i].changes.filter(change => !common.has(change.file))
      assert.ok(own.length > 0 && own.every(change => change.action === 'create'))
      ownCounts.push(own.length)
      const status = bootstrap[index].previewCreate.replace('{count}', own.length)
      assert.ok(lines.includes(`${name}: ${status}`), text)
    }
    const start = bootstrap[index].start.replace('{agents}', ['Codex', 'Hermes Agent'].join(lang === 'en' ? ', ' : '、'))
    const applied = launch(...args, '--apply')
    for (const [i, name] of ['Codex', 'Hermes Agent'].entries()) {
      const status = bootstrap[index].appliedCreate.replace('{count}', ownCounts[i])
      assert.ok(applied.split(/\r?\n/).includes(`${name}: ${status}`), applied)
    }
    assert.ok(applied.includes(`${bootstrap[index].shared}: ${bootstrap[index].appliedCreate.replace('{count}', common.size)}`), applied)
    for (const output of [text, applied]) {
      assert.equal(output.split(start).length - 1, 1, output)
      const data = join(root, 'data')
      const quoted = process.platform === 'win32' ? `'${data.replaceAll("'", "''")}'` : `'${data.replaceAll("'", "'\\''")}'`
      const location = /^[\w./:@=-]+$/.test(data) ? data : quoted
      const board = `npx @wenyuchiou/agent-board --data-dir ${location}`
      assert.ok(output.includes(`${board} --codex-trust --codex-bin `))
      assert.ok(output.includes(`${board} --hermes-trust`))
      assert.ok(output.includes(bootstrap[index].board.replace('{command}', 'npx @wenyuchiou/agent-board')))
      assert.doesNotMatch(output, /& '/)
      assert.ok(!output.includes(process.execPath), output)
    }
    const repeated = launch(...args)
    for (const name of ['Codex', 'Hermes Agent']) assert.ok(repeated.includes(`${name}: ${bootstrap[index].ready}`), repeated)
  })
})

test('setup with one agent asks for one new session, without "each of"', () => {
  for (const [index, lang] of locales.entries()) fixture(setup => {
    const said = setup('--agent', 'hermes', '--lang', lang)
    assert.ok(said.includes(bootstrap[index].startOne.replace('{agents}', 'Hermes Agent')), said)
    assert.ok(!said.includes(bootstrap[index].start.replace('{agents}', 'Hermes Agent')), said)
  })
})

test('setup separates newly created and updated files in its preview and apply (#1246)', () => fixture((setup, { env }) => {
  writeFileSync(join(env.CODEX_HOME, 'hooks.json'), '{"hooks":{},"synthetic":true}\n')
  const args = ['--agent', 'codex', '--lang', 'en']
  const plan = JSON.parse(setup(...args, '--json')).plans[0]
  const created = plan.changes.filter(change => change.action === 'create').length
  const updated = plan.changes.filter(change => change.action === 'update').length
  assert.ok(created > 0 && updated > 0)
  const line = setup(...args).split(/\r?\n/)[0]
  const previewCreateMsg = created === 1 ? bootstrap[0].previewCreateOne : bootstrap[0].previewCreate
  const previewUpdateMsg = updated === 1 ? bootstrap[0].previewOne : bootstrap[0].preview
  assert.ok(line.includes(previewCreateMsg.replace('{count}', created)), line)
  assert.ok(line.includes(previewUpdateMsg.replace('{count}', updated)), line)
  const appliedLine = setup(...args, '--apply').split(/\r?\n/)[0]
  const appliedCreateMsg = created === 1 ? bootstrap[0].appliedCreateOne : bootstrap[0].appliedCreate
  const appliedUpdateMsg = updated === 1 ? bootstrap[0].appliedOne : bootstrap[0].applied
  assert.ok(appliedLine.includes(appliedCreateMsg.replace('{count}', created)), appliedLine)
  assert.ok(appliedLine.includes(appliedUpdateMsg.replace('{count}', updated)), appliedLine)
}))

test('a repeat preview when every agent is already set up omits first-time steps and lists only open ones (#1246)', () => fixture(setup => {
  const applied = setup('--agent', 'opencode', '--lang', 'en', '--apply')
  assert.match(applied, /created \d+ setup files/)
  assert.match(applied, /restart OpenCode/i)
  assert.match(applied, /Then start a new session/i)
  assert.match(applied, /Open the board:/i)

  const repeat = setup('--agent', 'opencode', '--lang', 'en')
  assert.match(repeat, /OpenCode: already set up/)
  assert.doesNotMatch(repeat, /restart OpenCode/i)
  assert.doesNotMatch(repeat, /Then start a new session/i)
  assert.doesNotMatch(repeat, /Open the board:/i)
  assert.match(repeat, /Claude Code: run claude plugin/i)
}))

test('README quick start and troubleshooting document --no-open (#1246)', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /--no-open/)
  const zhTw = readFileSync(new URL('../README.zh-TW.md', import.meta.url), 'utf8')
  assert.match(zhTw, /--no-open/)
  const zhCn = readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8')
  assert.match(zhCn, /--no-open/)
})

test('the Antigravity apply summary accounts for every file counted by its preview', () => {
  for (const lang of locales) for (const targets of ['cursor,antigravity', 'antigravity,cursor']) fixture(setup => {
    const args = ['--agent', targets, '--lang', lang]
    const preview = setup(...args)
    const applied = setup(...args, '--apply')
    const counts = text => text.split(/\r?\n/).find(line => line.startsWith('Antigravity:')).match(/\d+/g)?.map(Number) ?? []
    const before = counts(preview)
    const after = counts(applied)
    assert.equal(before.length, 1)
    assert.ok(before[0] > 0)
    assert.equal(after.reduce((sum, n) => sum + n, 0), before[0], 'Antigravity preview/apply lost the files another selected agent already updated')
    const repeated = setup(...args)
    assert.ok(repeated.split(/\r?\n/).find(line => line.startsWith('Antigravity:')).includes(bootstrap[locales.indexOf(lang)].ready), repeated)
  })
})

// Two setup runs only: the bootstrap contract above checks all three canonical tables.
test('on Windows setup says to start cursor-agent from PowerShell, in its preview and after a yes (#1159)', () => {
  const isWindows = process.platform === 'win32'
  fixture(setup => {
    const preview = setup('--agent', 'cursor', '--lang', 'zh-TW')
    assert.equal(preview.includes(bootstrap[1].cursorWindows), isWindows, preview)
  })
  terminal(f => {
    const result = f.invoke(['--agent', 'cursor', '--lang', 'en'], 'y\n')
    succeeded(result)
    assert.equal(result.stdout.split('Next steps:')[1]?.includes(bootstrap[0].cursorWindows), isWindows, result.stdout)
  })
})

test('setup prints 1 setup file in the singular for a count of one in all six messages (#1270)', () => {
  const en = bootstrap[0]
  const keys = ['previewCreate', 'preview', 'previewRemove', 'appliedCreate', 'applied', 'appliedRemove']
  for (const key of keys) {
    const plural = en[key].replace('{count}', '1')
    const singular = en[`${key}One`].replace('{count}', '1')
    assert.equal(singular, en[key].replace('{count} setup files', '1 setup file'))
    assert.match(singular, /\b1 setup file\b/)
    assert.match(plural, /\b1 setup files\b/)
    assert.notEqual(singular, plural)
  }
  fixture((setup, { env }) => {
    setup('--agent', 'cursor', '--lang', 'en', '--apply')
    writeFileSync(join(env.HOME, '.cursor', 'hooks.json'), '{"version":1}\n')
    const preview = setup('--agent', 'cursor', '--lang', 'en')
    assert.match(preview, /would (?:create|update) 1 setup file\b/)
    assert.doesNotMatch(preview, /1 setup files\b/)
    const applied = setup('--agent', 'cursor', '--lang', 'en', '--apply')
    assert.match(applied, /(?:created|updated) 1 setup file\b/)
    assert.doesNotMatch(applied, /1 setup files\b/)
  })
})

test('a removal that changes one file says removed 1 setup file in the singular (#1270)', () => {
  fixture((setup, { env }) => {
    // The person's own Cursor hook, kept before setup and put back by hand after it, so the
    // removal has only the install record left to take away.
    const own = '{"version":1,"hooks":{"stop":[{"command":"echo synthetic"}]}}\n'
    mkdirSync(join(env.HOME, '.cursor'))
    writeFileSync(join(env.HOME, '.cursor', 'hooks.json'), own)
    setup('--agent', 'cursor', '--lang', 'en', '--apply')
    setup('--agent', 'muse', '--lang', 'en', '--apply')
    writeFileSync(join(env.HOME, '.cursor', 'hooks.json'), own)
    const preview = setup('--agent', 'cursor', '--lang', 'en', '--remove')
    assert.match(preview, /would remove 1 setup file\b/)
    assert.doesNotMatch(preview, /1 setup files\b/)
    const applied = setup('--agent', 'cursor', '--lang', 'en', '--remove', '--apply')
    assert.match(applied, /removed 1 setup file\b/)
    assert.doesNotMatch(applied, /1 setup files\b/)
  })
})

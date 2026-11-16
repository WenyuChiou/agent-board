import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { antigravitySidecarSource } from '../hooks/antigravity-sidecar.ts'

// Setup writes the Antigravity sidecar's two files only when the person says yes (the flag, or the one
// question that defaults to no). It never switches the sidecar on, and a remove takes the files away (#1396).
const installer = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url))
const TERMS = "Google's terms may not cover it"

const makeEnv = home => {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: process.env[pathKey] ?? '',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'),
    HERMES_HOME: join(home, '.hermes'), XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'), OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
  }
}
const withHome = (body) => {
  const home = mkdtempSync(join(tmpdir(), 'setup-sidecar-test-'))
  try {
    const run = (args, extra = {}) => spawnSync(process.execPath, [installer, '--home', home, '--lang', extra.lang ?? 'en', ...args], { cwd: home, env: { ...makeEnv(home), ...extra.env }, input: extra.input, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    const dir = join(home, '.gemini', 'config', 'sidecars', 'agent-board')
    body({ home, run, dir })
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('setup writes no sidecar unless the person asks: a plain apply leaves the folder out', () => withHome(({ run, dir }) => {
  const install = run(['--agent', 'antigravity', '--apply'])
  assert.equal(install.status, 0, install.stderr)
  assert.ok(!existsSync(dir), 'no sidecar folder without a yes')
  assert.ok(!install.stdout.includes(TERMS), install.stdout)
}))

test('with --antigravity-sidecar setup writes sidecar.json and sidecar.mjs, says the terms line, and never enables it', () => withHome(({ home, run, dir }) => {
  const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'])
  assert.equal(install.status, 0, install.stderr)
  const config = JSON.parse(readFileSync(join(dir, 'sidecar.json'), 'utf8'))
  assert.equal(config.restart_policy, 'always')
  assert.deepEqual(config.args.slice(0, 1), ['sidecar.mjs'])
  assert.equal(config.args[config.args.indexOf('--home') + 1], home)
  assert.ok(!('enabled' in config), 'setup never writes enabled')
  assert.equal(readFileSync(join(dir, 'sidecar.mjs'), 'utf8'), antigravitySidecarSource())
  assert.ok(install.stdout.includes(TERMS), install.stdout)
  assert.ok(install.stdout.includes('Automations'), install.stdout)
}))

test('a later plain setup keeps the sidecar it wrote, and a preview with the flag names it and the terms line', () => withHome(({ run, dir }) => {
  const preview = run(['--agent', 'antigravity', '--antigravity-sidecar'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(preview.stdout.includes('sidecar.json') && preview.stdout.includes(TERMS), preview.stdout)
  assert.ok(!existsSync(dir), 'a preview writes nothing')
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  const again = run(['--agent', 'antigravity', '--apply'])
  assert.equal(again.status, 0, again.stderr)
  assert.ok(existsSync(join(dir, 'sidecar.json')) && existsSync(join(dir, 'sidecar.mjs')), 'the second setup keeps the sidecar')
}))

test('--remove takes out both sidecar files setup wrote', () => withHome(({ run, dir }) => {
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  assert.ok(existsSync(join(dir, 'sidecar.json')))
  const preview = run(['--remove', '--agent', 'antigravity'])
  assert.ok(preview.stdout.includes('sidecar.json') && preview.stdout.includes('sidecar.mjs'), preview.stdout)
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(!existsSync(join(dir, 'sidecar.json')) && !existsSync(join(dir, 'sidecar.mjs')), 'both files are gone')
}))

test('in a terminal the sidecar question defaults to no: an empty second answer writes nothing and the question carries the terms line', () => withHome(({ run, dir }) => {
  // The first answer (yes) is read with the rest of the input; the second read then finds none, which is a no.
  const asked = run(['--agent', 'antigravity'], { input: 'y\n', env: { AGENT_BOARD_SETUP_TTY: '1', AGENT_BOARD_TEST_PID: String(process.pid) } })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(asked.stdout.includes(TERMS), asked.stdout)
  assert.ok(asked.stdout.includes('[y/N]'), asked.stdout)
  assert.ok(!existsSync(dir), 'a no writes nothing')
}))

// No Claude Code on PATH, so the only thing a terminal run can offer is Antigravity's own files and the sidecar question.
const TTY = { AGENT_BOARD_SETUP_TTY: '1', AGENT_BOARD_TEST_PID: String(process.pid), [Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH']: '' }

test('in a terminal a yes to both questions writes the sidecar files and says the terms line', () => withHome(({ run, dir }) => {
  const asked = run(['--agent', 'antigravity'], { input: 'y\ny\n', env: TTY })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(existsSync(join(dir, 'sidecar.json')) && existsSync(join(dir, 'sidecar.mjs')), asked.stdout)
  assert.ok(asked.stdout.includes('Automations'), asked.stdout)
}))

test('an install made without the sidecar is asked the sidecar question alone on the next setup, and a yes writes its files', () => withHome(({ run, dir }) => {
  assert.equal(run(['--agent', 'antigravity', '--apply']).status, 0)
  assert.ok(!existsSync(dir))
  const asked = run(['--agent', 'antigravity'], { input: 'y\n', env: TTY })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(asked.stdout.includes('[y/N]'), asked.stdout)
  assert.ok(existsSync(join(dir, 'sidecar.json')) && existsSync(join(dir, 'sidecar.mjs')), asked.stdout)
  // With the files in place the question is not asked again.
  const again = run(['--agent', 'antigravity'], { input: 'y\n', env: TTY })
  assert.equal(again.status, 0, again.stderr)
  assert.ok(!again.stdout.includes('[y/N]'), again.stdout)
}))

test('a no to the lone sidecar question writes nothing and leaves the question for the next setup', () => withHome(({ run, dir }) => {
  assert.equal(run(['--agent', 'antigravity', '--apply']).status, 0)
  const asked = run(['--agent', 'antigravity'], { input: '\n', env: TTY })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(asked.stdout.includes('[y/N]'), asked.stdout)
  assert.ok(!existsSync(dir), 'an empty answer is a no')
  assert.ok(run(['--agent', 'antigravity'], { input: '\n', env: TTY }).stdout.includes('[y/N]'), 'asked again')
}))

test('structured output carries the terms line whenever a run writes the sidecar, also a run that only updates sidecar.mjs', () => withHome(({ home, run, dir }) => {
  const first = JSON.parse(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply', '--json']).stdout)
  assert.ok(first.sidecarNotice.includes(TERMS), JSON.stringify(first.sidecarNotice))
  // An earlier setup wrote an older sidecar.mjs: its record holds that file's hash, so the next run only updates it.
  const record = join(home, '.agent-board', 'install-antigravity.json')
  const old = '// an older sidecar\n'
  writeFileSync(join(dir, 'sidecar.mjs'), old)
  const text = JSON.parse(readFileSync(record, 'utf8'))
  text.files[join(dir, 'sidecar.mjs')] = createHash('sha256').update(old).digest('hex')
  writeFileSync(record, JSON.stringify(text))
  const later = JSON.parse(run(['--agent', 'antigravity', '--apply', '--json']).stdout)
  assert.deepEqual(later.plans[0].changes.map(change => basename(change.file)).filter(name => name.startsWith('sidecar')), ['sidecar.mjs'])
  assert.ok(later.sidecarNotice.includes(TERMS), JSON.stringify(later))
  assert.ok(!run(['--agent', 'antigravity', '--apply']).stdout.includes(TERMS), 'a run that writes no sidecar file says nothing of it')
}))

test('the Automations description follows the setup language in all three languages', () => withHome(({ run, dir }) => {
  const seen = new Set()
  const words = { en: 'starts a new turn', 'zh-TW': '看板有訊息', 'zh-CN': '看板有消息' }
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const done = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { lang })
    assert.equal(done.status, 0, done.stderr)
    const description = JSON.parse(readFileSync(join(dir, 'sidecar.json'), 'utf8')).description
    assert.ok(description.includes(words[lang]), `${lang}: ${description}`)
    seen.add(description)
  }
  assert.equal(seen.size, 3, 'a different line in each language')
}))

// The connector's record says it hooked Antigravity, so setup leaves that agent's hooks to it.
const connectorHome = home => {
  const root = join(home, '.agent-board')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, '.gemini', 'antigravity'), { recursive: true })
  const progress = join(home, '.claude', 'progress.md')
  const record = { version: 1, revision: 1, disabled: false, owned: {}, notified: [], connectedProgress: progress, setup: { agents: [{ agent: 'antigravity', label: 'Antigravity', hook: 'configured', board: 'none' }], problems: [], node: process.version } }
  writeFileSync(join(root, 'legacy-connect.json'), JSON.stringify(record))
  return { root, progress }
}

test('where the connector manages Antigravity, a yes writes the sidecar files without taking over its hooks, and remove takes them out', () => withHome(({ home, run, dir }) => {
  const { root, progress } = connectorHome(home)
  const asked = run(['--agent', 'antigravity'], { input: 'y\n', env: TTY })
  assert.equal(asked.status, 0, asked.stderr)
  assert.ok(existsSync(join(dir, 'sidecar.json')) && existsSync(join(dir, 'sidecar.mjs')), asked.stdout)
  const config = JSON.parse(readFileSync(join(dir, 'sidecar.json'), 'utf8'))
  assert.equal(config.args[config.args.indexOf('--progress-file') + 1], progress)
  assert.ok(!existsSync(join(home, '.gemini', 'config', 'hooks.json')), 'the connector keeps its hooks')
  assert.ok(!existsSync(join(root, 'install-antigravity.json')), 'no install record of the agent itself')
  const preview = JSON.parse(run(['--agent', 'antigravity', '--json']).stdout)
  assert.equal(preview.plans[0].managedBy, 'connector')
  assert.deepEqual(preview.plans[0].changes, [])
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'])
  assert.equal(removed.status, 0, removed.stderr + removed.stdout)
  assert.ok(!existsSync(join(dir, 'sidecar.json')) && !existsSync(join(dir, 'sidecar.mjs')), 'both files are gone')
  assert.ok(!existsSync(join(root, 'install-antigravity-sidecar.json')))
}))

test('the flag writes the sidecar files for a connector-managed Antigravity and the structured output carries the terms line', () => withHome(({ home, run, dir }) => {
  connectorHome(home)
  const applied = JSON.parse(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply', '--json']).stdout)
  assert.equal(applied.plans[0].managedBy, 'connector')
  assert.ok(applied.sidecarNotice.includes(TERMS), JSON.stringify(applied))
  assert.ok(existsSync(join(dir, 'sidecar.json')))
  assert.ok(!existsSync(join(home, '.gemini', 'config', 'hooks.json')))
}))

test('the sidecar sends its wake line in the setup language: zh-TW for a zh-TW setup, the English line by default', () => withHome(({ run, dir }) => {
  const english = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'])
  assert.equal(english.status, 0, english.stderr)
  const englishSource = readFileSync(join(dir, 'sidecar.mjs'), 'utf8')
  assert.ok(englishSource.includes('const WAKE_LINE = "Agent Board: a message from the board is attached to this turn. Follow it."'), 'the default is the English line')
  assert.equal(englishSource, antigravitySidecarSource())
}))

test('a zh-TW setup writes the zh-TW wake line into the sidecar', () => withHome(({ run, dir }) => {
  const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { lang: 'zh-TW' })
  assert.equal(install.status, 0, install.stderr)
  const source = readFileSync(join(dir, 'sidecar.mjs'), 'utf8')
  assert.ok(source.includes('const WAKE_LINE = "Agent Board：看板的訊息已附在這一輪，請照著處理。"'), source.split('\n').find(line => line.startsWith('const WAKE_LINE')))
  assert.ok(!source.includes('a message from the board is attached'), 'no English line in a zh-TW sidecar')
}))

// A preload the installer's processes load through NODE_OPTIONS: it plays a person who edits sidecar.mjs at one
// moment of the apply, so the tests can show that setup reads each file again before its change and checks it after.
const seam = (home, body) => {
  const file = join(home, 'seam.mjs')
  writeFileSync(file, `import fs from 'node:fs'\nimport { syncBuiltinESMExports } from 'node:module'\n${body}\nsyncBuiltinESMExports()\n`)
  return { NODE_OPTIONS: `--import ${pathToFileURL(file).href}` }
}
const EDIT = '// the person edited this file\n'

test('an edit to sidecar.mjs made after setup planned is kept: setup fails instead of writing over it', () => withHome(({ home, run, dir }) => {
  connectorHome(home)
  // The edit lands when setup opens its temporary copy of sidecar.mjs, after the plan and the batch check.
  const env = seam(home, `const open = fs.openSync
let done = false
fs.openSync = (file, ...rest) => {
  const at = typeof file === 'string' && file.endsWith('.tmp') ? file.lastIndexOf('sidecar.mjs.') : -1
  if (!done && at >= 0) { done = true; fs.writeFileSync(file.slice(0, at) + 'sidecar.mjs', ${JSON.stringify(EDIT)}) }
  return open(file, ...rest)
}`)
  const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { env })
  assert.notEqual(install.status, 0, install.stdout)
  assert.equal(readFileSync(join(dir, 'sidecar.mjs'), 'utf8'), EDIT)
}))

test('an edit to sidecar.mjs made while remove runs is kept: remove fails instead of deleting it', () => withHome(({ home, run, dir }) => {
  connectorHome(home)
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  // The edit lands right after remove took out sidecar.json, before it reaches sidecar.mjs.
  const env = seam(home, `const unlink = fs.unlinkSync
fs.unlinkSync = file => {
  unlink(file)
  if (typeof file === 'string' && file.endsWith('sidecar.json')) fs.writeFileSync(file.slice(0, -'sidecar.json'.length) + 'sidecar.mjs', ${JSON.stringify(EDIT)})
}`)
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'], { env })
  assert.notEqual(removed.status, 0, removed.stdout)
  assert.equal(readFileSync(join(dir, 'sidecar.mjs'), 'utf8'), EDIT)
}))

test('setup fails when sidecar.mjs does not hold the text it wrote right after the write', () => withHome(({ home, run }) => {
  connectorHome(home)
  const env = seam(home, `const rename = fs.renameSync
fs.renameSync = (from, to) => {
  rename(from, to)
  if (typeof to === 'string' && to.endsWith('sidecar.mjs')) fs.writeFileSync(to, ${JSON.stringify(EDIT)})
}`)
  const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { env })
  assert.notEqual(install.status, 0, install.stdout)
}))

// Setup stopped because a file changed under it, not for another reason.
const stoppedOnChange = result => {
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(`${result.stdout}${result.stderr}`, /a file changed, or another setup was running, while setup worked/)
}
// A standalone install (no connector) goes through setup's main writer, not the sidecar-only one (#1488).
// The preload edits one file the first time setup opens that file's temporary copy, after the plan and the batch check.
const editOnOpen = (home, name) => seam(home, `const open = fs.openSync
let done = false
fs.openSync = (file, ...rest) => {
  const at = typeof file === 'string' && file.endsWith('.tmp') ? file.lastIndexOf(${JSON.stringify(`${name}.`)}) : -1
  if (!done && at >= 0) { done = true; fs.writeFileSync(file.slice(0, at) + ${JSON.stringify(name)}, ${JSON.stringify(EDIT)}) }
  return open(file, ...rest)
}`)

for (const name of ['sidecar.json', 'sidecar.mjs', 'hooks.json']) {
  test(`a standalone install keeps an edit to ${name} made after setup planned: setup fails instead of writing over it`, () => withHome(({ home, run, dir }) => {
    const hooks = join(home, '.gemini', 'config', 'hooks.json')
    const file = name === 'hooks.json' ? hooks : join(dir, name)
    const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { env: editOnOpen(home, name) })
    stoppedOnChange(install)
    assert.equal(readFileSync(file, 'utf8'), EDIT)
  }))
}

test('a standalone remove keeps sidecar.mjs when it is edited after sidecar.json went: remove fails instead of deleting it', () => withHome(({ home, run, dir }) => {
  assert.equal(run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply']).status, 0)
  const env = seam(home, `const unlink = fs.unlinkSync
fs.unlinkSync = file => {
  unlink(file)
  if (typeof file === 'string' && file.endsWith('sidecar.json')) fs.writeFileSync(file.slice(0, -'sidecar.json'.length) + 'sidecar.mjs', ${JSON.stringify(EDIT)})
}`)
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'], { env })
  stoppedOnChange(removed)
  assert.equal(readFileSync(join(dir, 'sidecar.mjs'), 'utf8'), EDIT)
}))

test('a standalone remove keeps hooks.json when it is edited after another file went: remove fails instead of deleting it', () => withHome(({ home, run }) => {
  assert.equal(run(['--agent', 'antigravity', '--apply']).status, 0)
  const hooks = join(home, '.gemini', 'config', 'hooks.json')
  const env = seam(home, `const unlink = fs.unlinkSync
let done = false
fs.unlinkSync = file => {
  unlink(file)
  if (!done && typeof file === 'string' && !file.endsWith('hooks.json') && fs.existsSync(${JSON.stringify(hooks)})) { done = true; fs.writeFileSync(${JSON.stringify(hooks)}, ${JSON.stringify(EDIT)}) }
}`)
  const removed = run(['--remove', '--agent', 'antigravity', '--apply'], { env })
  stoppedOnChange(removed)
  assert.equal(readFileSync(hooks, 'utf8'), EDIT)
}))

for (const name of ['sidecar.mjs', 'hooks.json']) {
  test(`a standalone install fails when ${name} does not hold the text it wrote right after the write`, () => withHome(({ home, run }) => {
    const env = seam(home, `const rename = fs.renameSync
fs.renameSync = (from, to) => {
  rename(from, to)
  if (typeof to === 'string' && to.endsWith(${JSON.stringify(name)})) fs.writeFileSync(to, ${JSON.stringify(EDIT)})
}`)
    const install = run(['--agent', 'antigravity', '--antigravity-sidecar', '--apply'], { env })
    stoppedOnChange(install)
  }))
}

// Hermes's skills folder linked to the shared one gives one file two names in one batch. The second write finds the
// text the first wrote, which loses nothing, so setup and remove go through (codex_468 on #1594).
test('a Hermes skills folder linked to the shared skills folder installs and removes without a false changed-file stop', () => withHome(({ home, run }) => {
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  mkdirSync(join(home, '.hermes'), { recursive: true })
  symlinkSync(join(home, '.agents', 'skills'), join(home, '.hermes', 'skills'), 'junction')
  const install = run(['--agent', 'hermes', '--apply'])
  assert.equal(install.status, 0, `${install.stdout}${install.stderr}`)
  const skill = readFileSync(join(home, '.agents', 'skills', 'agent-board', 'SKILL.md'), 'utf8')
  assert.equal(readFileSync(join(home, '.hermes', 'skills', 'agent-board', 'SKILL.md'), 'utf8'), skill)
  const removed = run(['--remove', '--agent', 'hermes', '--apply'])
  assert.equal(removed.status, 0, `${removed.stdout}${removed.stderr}`)
}))

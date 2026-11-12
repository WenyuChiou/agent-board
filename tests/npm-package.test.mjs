import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { bundleFiles, bundleFromDir } from '../scripts/bundle-text.mjs'
import { setupPrograms } from './helpers/setup-programs.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin/plugin.json'), 'utf8'))
// A folder as the launcher shows it in a command for this system's shell (bin/agent-board.mjs `quoted`).
const shellQuoted = path => process.platform !== 'win32' ? `'${path.replaceAll("'", "'\\''")}'` : /[$`]/.test(path) ? `'${path.replaceAll("'", "''")}'` : `"${path}"`
const save = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const filesUnder = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? filesUnder(path) : [path]
}).sort()
const fixture = fn => {
  const box = mkdtempSync(join(tmpdir(), 'agent-board npm-'))
  const home = join(box, 'home')
  const tmp = join(box, 'tmp')
  const cache = join(box, 'npm-cache')
  for (const dir of [home, tmp, cache]) mkdirSync(dir)
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp,
    CLAUDE_PROGRESS_FILE: '', CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), HERMES_HOME: join(home, '.hermes'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'), DSH_HOME: join(home, '.dsh'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: join(tmp, 'run'),
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    LANG: 'en_US.UTF-8', NO_COLOR: '1', npm_config_update_notifier: 'false',
    npm_config_cache: cache, npm_config_userconfig: join(box, 'npmrc'), npm_config_globalconfig: join(box, 'global-npmrc'),
    // A board these runs start opens no window and stops once this test process is gone (#959, #1016).
    // Without it a desktop run opens an Edge window per plain call, whose profile under this home is
    // locked while the private-path scan reads it.
    AGENT_BOARD_TEST_PID: String(process.pid),
  }
  const run = (pkg, args = [], extraEnv = {}, input) => spawnSync(process.execPath, [join(pkg, 'bin/agent-board.mjs'), ...args], {
    cwd: box, env: { ...env, ...extraEnv }, input, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  try { return fn({ box, home, tmp, env, run }) }
  finally {
    try {
      rmSync(box, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 })
    } catch {
      // Windows transient file lock
    }
  }
}
const success = result => {
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
}

test('the launcher falls back to the system language before setup', () => fixture(f => {
  const env = { LANG: '', NODE_OPTIONS: `--require ${JSON.stringify(join(repo, 'tests/fixtures/system-lang-zh-tw.cjs'))}` }
  const help = f.run(repo, ['--help'], env)
  success(help)
  assert.match(help.stdout, /給程式 agent 用的本機看板/)
  assert.doesNotMatch(help.stdout, /a local board for coding agents/)
  const missing = f.run(repo, [], env)
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stderr, /這個帳號還沒設定 Agent Board/)
  assert.doesNotMatch(missing.stderr, /not set up for this account/)
}))

test('every Quick start says how to choose the language', () => {
  for (const [file, heading, language] of [['README.md', 'Quick start', 'en'], ['README.zh-TW.md', '快速開始', 'zh-TW'], ['README.zh-CN.md', '快速开始', 'zh-CN']]) {
    const section = readFileSync(join(repo, file), 'utf8').split(`## ${heading}`)[1]?.split('\n## ')[0]
    assert.ok(section, `${file} has its Quick start section`)
    assert.ok(section.includes(`--lang ${language}`), `${file} explains its language flag`)
  }
})

let packedResult
const pack = () => {
  if (!packedResult) {
    try {
      packedResult = fixture(f => {
        const result = spawnSync('npm pack --dry-run --json --ignore-scripts', {
          cwd: repo, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 60000, shell: true,
        })
        success(result)
        assert.equal(result.stderr.includes('DEP0190'), false, result.stderr)
        return { paths: JSON.parse(result.stdout)[0].files.map(file => file.path).sort() }
      })
    } catch (error) { packedResult = { error } }
  }
  if (packedResult.error) throw packedResult.error
  return packedResult.paths
}
const packed = f => {
  const pkg = join(f.box, 'package')
  for (const path of pack()) {
    const dest = join(pkg, path)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(repo, path), dest)
  }
  return pkg
}
const bundle = pkg => bundleFromDir(pkg)
const bodyHash = text => createHash('sha256').update(text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '').digest('hex')
const boardPath = f => join(f.home, '.agent-board/agent-board.mjs')
const prelude = f => `globalThis.AGENT_BOARD = ${JSON.stringify({ path: join(f.home, '.agent-board/progress.md'), lang: 'en', codexRoot: dirname(boardPath(f)) })}\n`
const fake = 'globalThis.AGENT_BOARD = {}\nprocess.stdout.write(JSON.stringify({ argv1: process.argv[1], args: process.argv.slice(2) }))\n'
const unnamed = (result, pkg) => {
  assert.equal(result.stdout.includes(pkg), false, result.stdout)
  assert.equal(result.stdout.includes(JSON.stringify(pkg).slice(1, -1)), false, result.stdout)
}

test('npm pack publishes only the files package.json lists', () => {
  assert.deepEqual(pack(), [...manifest.files, 'package.json', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'LICENSE'].sort())
})

test('the README footer names the latest stable version, not the package version', () => {
  // A pre-release package keeps the last stable version in its README footer (#813), so the
  // footer must say that is what the version is, in every language, and all three must agree.
  const footers = [
    ['README.md', /<sub>Latest stable version: (\d+\.\d+\.\d+) ·/, /<sub>Version \d/],
    ['README.zh-CN.md', /<sub>最新稳定版本 (\d+\.\d+\.\d+) ·/, /<sub>版本 \d/],
    ['README.zh-TW.md', /<sub>最新穩定版本 (\d+\.\d+\.\d+) ·/, /<sub>版本 \d/],
  ]
  const versions = new Set()
  for (const [path, labelled, bare] of footers) {
    const text = readFileSync(join(repo, path), 'utf8')
    const match = text.match(labelled)
    assert.ok(match, `${path} names the latest stable version in its footer`)
    versions.add(match[1])
    assert.equal(bare.test(text), false, `${path} footer reads as the package's own version`)
  }
  assert.equal(versions.size, 1, `the three README footers name one stable version: ${[...versions].join(', ')}`)
})

test('the npm package lists every bundle part and the reader, and the installed command reads them', () => fixture(f => {
  const files = bundleFiles(repo)
  assert.ok(files.length >= 3, 'the bundle is kept in its entry and at least two parts')
  const listed = pack()
  for (const path of [...files, 'scripts/bundle-text.mjs']) assert.ok(listed.includes(path), `${path} is published`)
  // A part left in hooks/ that the entry no longer imports would be a stale file the package ships.
  assert.deepEqual(readdirSync(join(repo, 'hooks')).filter(name => /^board-script(?:-\d+)?\.ts$/.test(name)).map(name => `hooks/${name}`).sort(), [...files].sort())
  const pkg = packed(f)
  // The installed copy is this package's own bundle, so the command finds nothing to say.
  save(boardPath(f), `${prelude(f)}${bundle(pkg)}`)
  const same = f.run(pkg)
  success(same)
  assert.ok(same.stdout.trim())
  assert.equal(same.stderr, '')
  // One part missing from the package: the installed script still runs, and the command says it could not compare.
  rmSync(join(pkg, 'hooks/board-script-2.ts'))
  const unreadable = f.run(pkg)
  success(unreadable)
  assert.ok(unreadable.stderr.includes('could not compare'))
  assert.ok(unreadable.stderr.includes('ENOENT'))
  assert.equal(unreadable.stderr.trim().split('\n').length, 1)
}))

test('the package has no dependencies and no install scripts', () => {
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'scripts', 'main']) {
    assert.equal(Object.hasOwn(manifest, key), false, key)
  }
  assert.deepEqual(Object.keys(manifest), ['name', 'version', 'description', 'type', 'bin', 'files', 'engines', 'publishConfig', 'license', 'author', 'homepage', 'repository', 'bugs', 'keywords'])
  assert.equal(manifest.description, plugin.description)
  assert.deepEqual(manifest.keywords, [...plugin.keywords, 'claude-code', 'cli'])
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.bin, { 'agent-board': 'bin/agent-board.mjs' })
  assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'next' })
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.license, 'MIT')
  for (const path of manifest.files) assert.equal(statSync(join(repo, path)).isFile(), true, path)
  assert.ok(readFileSync(join(repo, manifest.bin['agent-board']), 'utf8').startsWith('#!/usr/bin/env node\n'))
  assert.equal(readFileSync(join(repo, 'package.json'), 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`)
})

test('the npm command and package.json keep LF line endings on every checkout', () => fixture(f => {
  // A Windows checkout turns LF into CRLF unless .gitattributes says otherwise, and a CR after
  // the first line's "node" breaks the command on Linux and macOS when published from there.
  const result = spawnSync('git', ['check-attr', 'eol', '--', 'bin/agent-board.mjs', 'package.json'], { cwd: repo, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.replace(/\r/g, ''), 'bin/agent-board.mjs: eol: lf\npackage.json: eol: lf\n')
  for (const path of ['bin/agent-board.mjs', 'package.json']) assert.equal(readFileSync(join(repo, path), 'utf8').includes('\r'), false, path)
}))

test('the board bundle keeps LF on every checkout and stays under the Claude Code module limit', () => fixture(f => {
  // The bundle has one line per line, so a Windows checkout with CRLF adds a byte per line and
  // takes it past the 1 MiB that Claude Code reads from one module (#582).
  // When a size check fails, add a split point to PART_STARTS in scripts/build-board.ts; do not trim
  // features to fit.
  const files = bundleFiles(repo)
  assert.ok(files.length > 1, files.join(', '))
  const result = spawnSync('git', ['check-attr', 'eol', '--', ...files], { cwd: repo, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.replace(/\r/g, ''), files.map(path => `${path}: eol: lf\n`).join(''))
  for (const path of files) {
    const bundle = readFileSync(join(repo, path))
    assert.equal(bundle.includes(13), false, path)
    assert.ok(bundle.length < 1048576, `${path}: ${bundle.length} bytes`)
  }
}))

test('package.json, plugin.json and agent-board --version report one version', () => fixture(f => {
  assert.equal(manifest.version, plugin.version)
  const pkg = packed(f)
  for (const args of [['--version'], ['-v'], ['help', '--version']]) {
    const result = f.run(pkg, args)
    success(result)
    assert.equal(result.stdout, `agent-board ${manifest.version}\n`)
    assert.equal(result.stderr, '')
  }
  assert.deepEqual(filesUnder(f.home), [])
}))

test('agent-board --help works in a scratch home with nothing installed and writes nothing', () => fixture(f => {
  const pkg = packed(f)
  for (const args of [['--help'], ['-h'], ['help'], ['setup', '--help'], ['setup', '-h', '--version']]) {
    const result = f.run(pkg, args)
    success(result)
    assert.ok(result.stdout.includes('agent-board setup --apply'))
    assert.ok(!result.stdout.includes('--serve'), 'plain help does not name the old --serve')
    assert.ok(result.stdout.includes(`Without installing: npx ${manifest.name} <the same options>`))
    assert.equal(result.stderr, '')
  }
  const tw = f.run(pkg, ['--help', '--lang', 'zh-TW'])
  success(tw)
  assert.ok(tw.stdout.includes('終端機'))
  assert.ok(tw.stdout.includes(`不安裝也能用：npx ${manifest.name} <同樣的選項>`))
  const cn = f.run(pkg, ['--help'], { LANG: 'zh_CN.UTF-8' })
  success(cn)
  assert.ok(cn.stdout.includes('终端'))
  assert.ok(cn.stdout.includes(`不安装也能用：npx ${manifest.name} <同样的选项>`))
  assert.deepEqual(filesUnder(f.home), [])
}))

test('agent-board with no board installed says how to set it up and writes nothing', () => fixture(f => {
  const result = f.run(packed(f))
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes(`npx ${manifest.name} setup --apply`))
  assert.ok(result.stderr.includes(`  ${boardPath(f)}\n`))
  assert.ok(result.stderr.includes(`  ${join(f.env.CLAUDE_CONFIG_DIR, 'agent-board.mjs')}\n`))
  assert.deepEqual(filesUnder(f.home), [])
}))

const terminalLauncher = f => {
  const preload = join(f.box, 'terminal.cjs')
  // Only the launcher sees a fake TTY here; setup uses its own explicit test seam.
  save(preload, `if (/[\\\\/]bin[\\\\/]agent-board\\.mjs$/.test(process.argv[1] || '')) { process.stdin.isTTY = true; process.stdout.isTTY = true }\n`)
  return { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, AGENT_BOARD_SETUP_TTY: '1', AGENT_BOARD_TEST_PID: String(process.pid), CI: '1' }
}

test('the bare terminal launcher accepts Enter once for files, trust and the Claude plugin', () => fixture(f => {
  const commands = setupPrograms(f.box, f.env)
  const result = f.run(packed(f), [], terminalLauncher(f), '\n')
  success(result)
  assert.equal(result.stdout.split('Set these up? [Y/n]').length - 1, 1)
  assert.match(result.stdout, /Codex files: done\./)
  assert.match(result.stdout, /Approve the board's hooks in Codex: done\./)
  assert.match(result.stdout, /Approve the board's hooks in Hermes Agent: done\./)
  assert.match(result.stdout, /Claude Code plugin: done\./)
  assert.equal(statSync(boardPath(f)).isFile(), true)
  assert.ok(readFileSync(join(f.env.HERMES_HOME, 'shell-hooks-allowlist.json'), 'utf8').includes('approvals'))
  assert.equal(commands.calls().filter(call => call.method === 'config/batchWrite').length, 1)
  assert.deepEqual(commands.calls().filter(call => call.program === 'claude').map(call => call.args), [
    ['plugin', 'marketplace', 'add', 'WenyuChiou/agent-board'],
    ['plugin', 'install', 'agent-board@agent-board'],
  ])
  assert.doesNotMatch(result.stdout, /Apply these changes\? \[y\/N\]/)
}))

test('declining the bare terminal launcher leaves the account unconfigured', () => fixture(f => {
  const commands = setupPrograms(f.box, f.env)
  const result = f.run(packed(f), [], terminalLauncher(f), 'n\n')
  assert.ifError(result.error)
  success(result)
  assert.equal(result.stdout.split('Set these up? [Y/n]').length - 1, 1)
  assert.match(result.stdout, /Apply these changes: .*--apply/)
  assert.deepEqual(filesUnder(f.home), [])
  assert.deepEqual(commands.calls(), [])
}))

test('the bare terminal launcher finishes a Claude-only setup before its next session creates the board', () => fixture(f => {
  const commands = setupPrograms(f.box, f.env, ['claude'])
  const result = f.run(packed(f), [], terminalLauncher(f), '\n')
  success(result)
  assert.equal(result.stdout.split('Set these up? [Y/n]').length - 1, 1)
  assert.match(result.stdout, /Claude Code plugin: done\./)
  assert.match(result.stdout, /Open a new session in Claude Code\.\r?\n\d\. Then type \/agent-board there\./)
  assert.deepEqual(commands.calls().filter(call => call.program === 'claude').map(call => call.args), [
    ['plugin', 'marketplace', 'add', 'WenyuChiou/agent-board'],
    ['plugin', 'install', 'agent-board@agent-board'],
  ])
  assert.equal(filesUnder(f.home).some(path => path.endsWith('agent-board.mjs')), false)
}))

test('with --chat, a missing board names the home folder as ~ and nothing else changes', () => fixture(f => {
  const result = f.run(packed(f), ['--chat'])
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes(`  ~${boardPath(f).slice(f.home.length)}\n`), result.stderr)
  assert.equal(result.stderr.includes(f.home), false, result.stderr)
  assert.ok(result.stderr.includes(`npx ${manifest.name} setup --apply`))
  assert.deepEqual(filesUnder(f.home), [])
}))

test('a board script whose bytes differ under the same version is a different build, not an update', () => fixture(f => {
  const pkg = packed(f)
  const text = `${prelude(f)}${bundle(pkg)}\n// untagged`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '${manifest.version}', board: ['${bodyHash(text)}'] }]\n`)
  const result = f.run(pkg)
  success(result)
  assert.ok(result.stderr.includes('a different build'), result.stderr)
  assert.equal(result.stderr.includes('setup --apply'), false, result.stderr)
}))

test('agent-board setup from the packed files previews, writes no file, and never names the package folder', t => fixture(f => {
  const pkg = packed(f)
  const result = f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--json'])
  success(result)
  assert.equal(JSON.parse(result.stdout).applied, false)
  assert.equal(result.stderr, '')
  unnamed(result, pkg)
  assert.deepEqual(filesUnder(f.home), [])
  t.diagnostic(`Setup preview leaves no files. Home entries: ${JSON.stringify(readdirSync(f.home))}`)
}))

test('after setup --apply from the packed files, agent-board runs the installed board script', () => fixture(f => {
  const pkg = packed(f)
  const setup = f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--apply', '--json'])
  success(setup)
  assert.equal(JSON.parse(setup.stdout).applied, true)
  assert.equal(setup.stderr, '')
  assert.equal(statSync(boardPath(f)).isFile(), true)
  unnamed(setup, pkg)
  for (const args of [['--chat'], []]) {
    const result = f.run(pkg, args)
    success(result)
    assert.ok(result.stdout.trim())
    assert.equal(result.stderr, '')
    // A test never opens a window on the tester's screen (#1016).
    assert.doesNotMatch(result.stdout, /Opened Agent Board in your browser/)
  }
  for (const path of filesUnder(f.home)) {
    const text = readFileSync(path, 'utf8')
    for (const privatePath of [pkg, JSON.stringify(pkg).slice(1, -1), pkg.replaceAll('\\', '/'), f.tmp]) {
      assert.equal(text.includes(privatePath), false, `${path} contains ${privatePath}`)
    }
  }
}))

test('an installed board script from another build gets a one-line note naming its release, and still runs', () => fixture(f => {
  const pkg = packed(f)
  const text = `${prelude(f)}${bundle(pkg)}\n// edited`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.0', board: ['${bodyHash(text)}'] }, { version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  const result = f.run(pkg)
  success(result)
  assert.ok(result.stdout.trim())
  assert.equal(result.stderr.trim().split('\n').length, 1)
  assert.ok(result.stderr.includes('is from 0.0.1.'))
  assert.ok(result.stderr.includes(`npx ${manifest.name}@${manifest.version} setup, then add --apply.`))
  assert.equal(result.stderr.includes('setup --apply'), false)
  const chat = f.run(pkg, ['--chat'])
  success(chat)
  assert.equal(chat.stderr, '')
  save(boardPath(f), `${text}\n// another edit`)
  const edited = f.run(pkg)
  success(edited)
  assert.ok(edited.stderr.includes('a different build'))
  assert.equal(edited.stderr.trim().split('\n').length, 1)
  rmSync(join(pkg, 'hooks/board-script.ts'))
  const unreadable = f.run(pkg)
  success(unreadable)
  assert.ok(unreadable.stderr.includes('could not compare'))
  assert.ok(unreadable.stderr.includes('ENOENT'))
  assert.equal(unreadable.stderr.trim().split('\n').length, 1)
}))

test('--json through an installed board script from an older release fails with the notice instead of printing text and exiting 0 (#1304)', () => fixture(f => {
  const pkg = packed(f)
  // What 0.24.2's script did with --json: print the text board and exit 0.
  const text = `${prelude(f)}process.stdout.write('Agent Board (text, not JSON)\\n')\n// 0.24.2`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  for (const [lang, older] of [['en', 'is from 0.24.2.'], ['zh-TW', '是 0.24.2 版']]) {
    const json = f.run(pkg, ['--json', '--lang', lang])
    assert.notEqual(json.status, 0, 'the call fails')
    assert.equal(json.stdout, '', 'nothing but JSON may ever reach stdout')
    assert.ok(json.stderr.includes(older), json.stderr)
    assert.ok(json.stderr.includes(`npx ${manifest.name}@${manifest.version} setup`), json.stderr)
    assert.equal(json.stderr.trim().split('\n').length, 1)
  }
  // Without --json the older script still runs, with the same note.
  const plain = f.run(pkg, ['--print'])
  success(plain)
  assert.ok(plain.stdout.includes('Agent Board (text, not JSON)'))
  assert.ok(plain.stderr.includes('is from 0.24.2.'))
}))

test('--json through an edited older board script still fails instead of printing text and exiting 0 (#1304, review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  const text = `${prelude(f)}process.stdout.write('Agent Board (text, not JSON)\\n')\n// 0.24.2`
  // An edited copy of a released script hashes as no release at all.
  save(boardPath(f), `${text}\n// edited by the person`)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  const edited = f.run(pkg, ['--json'])
  assert.notEqual(edited.status, 0, 'an edited older script cannot return JSON')
  assert.equal(edited.stdout, '', 'nothing but JSON may ever reach stdout')
  // A script that does return JSON is left alone, even when it is a build the package does not know.
  save(boardPath(f), `${prelude(f)}process.stdout.write('{"ok":true}\\n')\n// a newer build`)
  const newer = f.run(pkg, ['--json'])
  success(newer)
  assert.equal(newer.stdout, '{"ok":true}\n')
}))

test('--json through a build the package does not know hands over all of a large JSON output before the launcher exits (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  // An edited current script: the launcher holds its output to check it is JSON, then passes it on.
  const json = JSON.stringify({ items: 'x'.repeat(8 * 1024 * 1024) })
  save(boardPath(f), `${prelude(f)}process.stdout.write(${JSON.stringify(json)})\n// edited by the person`)
  // A reader that waits before it reads: the launcher's output then waits in its own queue, which an early exit drops
  // (stdout to a pipe is asynchronous on Windows and macOS).
  const reader = `const { spawn } = require('node:child_process')
const board = spawn(process.execPath, [${JSON.stringify(join(pkg, 'bin/agent-board.mjs'))}, '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
board.stdout.pause()
let size = 0
setTimeout(() => { board.stdout.on('data', chunk => { size += chunk.length }); board.stdout.resume() }, 1500)
board.stdout.on('end', () => process.stdout.write(String(size)))`
  const result = spawnSync(process.execPath, ['-e', reader], { cwd: f.box, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(result.stdout, String(json.length), 'every byte of the JSON reaches a reader that is slow to read')
}))

test('--json through a build the package does not know waits for an asynchronous stdout writer before it exits (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  save(boardPath(f), `${prelude(f)}process.stdout.write('{"ok":true}\\n')\n// edited by the person`)
  // A stdout that, like a pipe on macOS, takes a write now and delivers it a moment later (calling back when it has): an exit
  // before the callback loses the text. The preload records what was delivered before the process ended.
  const delivered = join(f.box, 'delivered.txt')
  const preload = join(f.box, 'async-stdout.cjs')
  save(preload, `const { appendFileSync } = require('node:fs')
// Only the launcher (bin/agent-board.mjs); the board script it starts inherits NODE_OPTIONS and writes normally.
if (/[\\\\/]bin[\\\\/]agent-board\\.mjs$/.test(process.argv[1] ?? '')) process.stdout.write = (text, callback) => {
  setTimeout(() => { appendFileSync(${JSON.stringify(delivered)}, String(text)); if (typeof callback === 'function') callback() }, 100)
  return true
}
`)
  const result = f.run(pkg, ['--json'], { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
  success(result)
  assert.equal(readFileSync(delivered, 'utf8'), '{"ok":true}\n', 'the JSON is delivered before the launcher exits')
}))

test('--json with --chat or --status through an older board script fails with the notice too (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  const text = `${prelude(f)}process.stdout.write('Agent Board (text, not JSON)\\n')\n// 0.24.2`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  for (const extra of ['--chat', '--status']) {
    const json = f.run(pkg, ['--json', extra])
    assert.notEqual(json.status, 0, `--json ${extra} fails through an older script`)
    assert.equal(json.stdout, '', `--json ${extra} prints no text`)
  }
}))

test('--json for a maintenance mode through an older board script runs it, as 0.24.2 answers --codex-doctor --json (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  // 0.24.2 printed the text board for a plain --json, but JSON for --codex-doctor --json.
  const text = `${prelude(f)}process.stdout.write(process.argv.includes('--codex-doctor') ? '{"doctor":"ok"}\\n' : process.argv.includes('--codex-trust') ? 'trust text\\n' : 'Agent Board (text, not JSON)\\n')\n// 0.24.2`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  const doctor = f.run(pkg, ['--codex-doctor', '--json'])
  success(doctor)
  assert.equal(doctor.stdout, '{"doctor":"ok"}\n')
  assert.ok(doctor.stderr.includes('is from 0.24.2.'), doctor.stderr)
  // A maintenance mode whose older script answers --json with text is still caught: its output is checked as JSON.
  const trust = f.run(pkg, ['--codex-trust', '--json'])
  assert.notEqual(trust.status, 0, 'text for --json fails')
  assert.equal(trust.stdout, '', 'nothing but JSON may ever reach stdout')
  // The board document itself is still refused before the older script runs.
  const board = f.run(pkg, ['--json'])
  assert.notEqual(board.status, 0)
  assert.equal(board.stdout, '')
}))

test('a Windows folder ending in a backslash reaches the command whole in cmd and PowerShell (#1328)', () => fixture(f => {
  const source = readFileSync(join(repo, 'bin/agent-board.mjs'), 'utf8')
  const start = source.indexOf('const quoted =')
  const end = source.indexOf('\nconst code =', start)
  assert.ok(start >= 0 && end > start)
  const helper = source.match(/^const doubleTrailingBackslashes = .+$/m)?.[0] ?? ''
  const quoted = runInNewContext(`${helper}\n${source.slice(start, end)}\nquoted`, { isWin: true })
  assert.equal(quoted('C:\\', 'cmd'), '"C:\\\\"')
  assert.equal(quoted('C:\\', 'powershell'), '"C:\\\\"')
  const withSpace = 'C:\\Synthetic board \\'
  const withDollar = 'C:\\Synthetic $board \\'
  assert.equal(quoted(withDollar, 'powershell'), "'C:\\Synthetic $board \\\\'")
  if (process.platform !== 'win32') return
  const probe = join(f.box, 'quote-probe.cmd')
  save(probe, `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv[1]))" ${quoted('C:\\', 'cmd')}\r\n`)
  const cmd = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${probe}"`], { env: f.env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
  assert.equal(cmd.status, 0, cmd.stderr)
  assert.equal(JSON.parse(cmd.stdout.trim()), 'C:\\')
  for (const path of [withSpace, withDollar]) {
    const command = `& '${process.execPath.replaceAll("'", "''")}' -e 'console.log(JSON.stringify(process.argv[1]))' ${quoted(path, 'powershell')}`
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env: f.env, encoding: 'utf8', windowsHide: true })
    assert.equal(ps.status, 0, ps.stderr)
    assert.equal(JSON.parse(ps.stdout.trim()), path)
  }
}))

test('the launcher passes the plugin update steps to the board it starts (#1328)', () => fixture(f => {
  const pkg = packed(f)
  const script = join(f.env.CLAUDE_CONFIG_DIR, 'agent-board.mjs')
  const text = `globalThis.AGENT_BOARD = {}\nprocess.stdout.write(JSON.stringify({ command: process.env.AGENT_BOARD_UPDATE_COMMAND, kind: process.env.AGENT_BOARD_UPDATE_KIND }))\n// 0.24.2`
  save(script, text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  const result = f.run(pkg, ['--print'])
  success(result)
  assert.deepEqual(JSON.parse(result.stdout), { command: '/progress connect', kind: 'plugin' })
}))

test('a custom path with % is shown once per shell on Windows, and each shell receives it exactly (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  // Command Prompt expands %USERNAME% even inside double quotes.
  const root = join(f.home, 'data %USERNAME% 100%')
  const echo = `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\nprocess.stdout.write('update=' + JSON.stringify(process.env.AGENT_BOARD_UPDATE_COMMAND ?? null))\n// 0.24.2`
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'agent-board.mjs'), echo)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(echo)}'] }]\n`)
  const shown = f.run(pkg, ['--data-dir', root, '--print'], { NODE_OPTIONS: `--require ${JSON.stringify(join(repo, 'tests/fixtures/platform-win32.cjs'))}` })
  success(shown)
  const base = `npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir`
  // For Command Prompt each % steps out of the quotes as ^%; PowerShell reads % inside double quotes as it is.
  const forCmd = `"${root.replaceAll('%', '"^%"')}"`
  assert.equal(shown.stdout, `update=${JSON.stringify(`Command Prompt: ${base} ${forCmd}; PowerShell: ${base} "${root}"`)}`)
  const lines = Object.fromEntries(shown.stderr.split(/\r?\n/).map(line => /^ {2}(Command Prompt|PowerShell): (.+)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]))
  assert.deepEqual(Object.keys(lines).sort(), ['Command Prompt', 'PowerShell'], shown.stderr)
  if (process.platform !== 'win32') return
  // Stand-in npx shims, as npm installs them (npx.cmd for Command Prompt, npx.ps1 for PowerShell), that record the arguments.
  const stub = join(f.box, 'stub')
  save(join(stub, 'npx.cmd'), `@"${process.execPath}" "%~dp0npx.js" %*\r\n`)
  save(join(stub, 'npx.ps1'), `& "${process.execPath}" "$PSScriptRoot\\npx.js" @args\r\nexit $LASTEXITCODE\r\n`)
  save(join(stub, 'npx.js'), "require('node:fs').writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)))\n")
  const out = join(f.box, 'argv.json')
  const path = `${stub};${f.env.PATH ?? f.env.Path}`
  // USERNAME is set, so an expanded %USERNAME% would show in the path received.
  const env = { ...f.env, PATH: path, Path: path, STUB_OUT: out, USERNAME: 'someone-else' }
  const shells = {
    'Command Prompt': command => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 }),
    PowerShell: command => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 }),
  }
  for (const [shell, runIn] of Object.entries(shells)) {
    rmSync(out, { force: true })
    const result = runIn(lines[shell])
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [`${manifest.name}@${manifest.version}`, 'setup', '--agent', 'codex', '--data-dir', root], shell)
  }
}))

// Two-hour review of #1328 (codex_127), finding 4: the advice for a script that returns text for --json names the data folder.
test('a script that does not return JSON for --json is answered with the update command for its own data folder (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  save(join(root, 'install-codex.json'), '{}')
  // Not a release the package knows, so the launcher holds its output and finds it is not JSON.
  save(join(root, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ lang: 'en' })}\nprocess.stdout.write('Agent Board (text, not JSON)\\n')\n// edited by the person`)
  const result = f.run(pkg, ['--data-dir', root, '--json'])
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes(`npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir ${shellQuoted(root)}`), result.stderr)
}))

// Finding 5: with --chat a folder under home is written home-relative, in a form each shell expands.
test('with --chat a custom folder under home is shown in a form each shell expands (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, "data dir it's")
  const reply = `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\nprocess.stdout.write(JSON.stringify({ update: process.env.AGENT_BOARD_UPDATE_COMMAND ?? null }))\n// 0.24.2`
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'agent-board.mjs'), reply)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(reply)}'] }]\n`)
  const shownFor = platform => {
    const result = f.run(pkg, ['--data-dir', root, '--codex-doctor', '--json', '--chat'], { NODE_OPTIONS: `--require ${JSON.stringify(join(repo, `tests/fixtures/platform-${platform}.cjs`))}` })
    success(result)
    return { update: JSON.parse(result.stdout).update, stderr: result.stderr }
  }
  const base = `npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir`
  // POSIX: a quoted ~ is not expanded, so the ~ stays outside the quotes.
  const posix = shownFor('posix')
  assert.equal(posix.update, `${base} ~/'data dir it'\\''s'`)
  assert.ok(posix.stderr.includes(posix.update), posix.stderr)
  // Windows: Command Prompt never expands ~, so each shell gets its own variable for the home folder.
  const windows = shownFor('win32')
  assert.equal(windows.update, `Command Prompt: ${base} "%USERPROFILE%\\data dir it's"; PowerShell: ${base} "$HOME\\data dir it's"`)
  if (process.platform !== 'win32') {
    // The shell that shows this command expands it to the folder.
    const result = spawnSync('sh', ['-c', `printf %s ${posix.update.slice(posix.update.indexOf('~'))}`], { env: f.env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.stdout, root)
    return
  }
  // Stand-in npx shims, as npm installs them, that record the arguments.
  const stub = join(f.box, 'stub')
  save(join(stub, 'npx.cmd'), `@"${process.execPath}" "%~dp0npx.js" %*\r\n`)
  save(join(stub, 'npx.ps1'), `& "${process.execPath}" "$PSScriptRoot\\npx.js" @args\r\nexit $LASTEXITCODE\r\n`)
  save(join(stub, 'npx.js'), "require('node:fs').writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)))\n")
  const out = join(f.box, 'argv.json')
  const path = `${stub};${f.env.PATH ?? f.env.Path}`
  const env = { ...f.env, PATH: path, Path: path, STUB_OUT: out }
  const lines = Object.fromEntries(windows.stderr.split(/\r?\n/).map(line => /^ {2}(Command Prompt|PowerShell): (.+)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]))
  assert.deepEqual(Object.keys(lines).sort(), ['Command Prompt', 'PowerShell'], windows.stderr)
  const shells = {
    'Command Prompt': command => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 }),
    PowerShell: command => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 }),
  }
  for (const [shell, runIn] of Object.entries(shells)) {
    rmSync(out, { force: true })
    const result = runIn(lines[shell])
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [`${manifest.name}@${manifest.version}`, 'setup', '--agent', 'codex', '--data-dir', root], shell)
  }
}))

// Finding 6: the failure notice of --chat shows the home folder as ~, like every other path in that output.
test('with --chat a failed comparison names the board script without the home folder (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  save(boardPath(f), `${prelude(f)}process.stdout.write('{"ok":true}\\n')\n// edited by the person`)
  // The package cannot be read for the comparison.
  rmSync(join(pkg, 'hooks/board-script.ts'), { force: true })
  const result = f.run(pkg, ['--chat', '--json'])
  success(result)
  assert.ok(result.stderr.includes('could not compare the board script at ~'), result.stderr)
  assert.equal(result.stderr.includes(f.home), false, result.stderr)
}))

test('the displayed update command quotes a custom path for the shell it is shown for (review of #1328)', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, "data $HOME $(touch pwned) it's")
  const echo = `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\nprocess.stdout.write('update=' + JSON.stringify(process.env.AGENT_BOARD_UPDATE_COMMAND ?? null))\n// 0.24.2`
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'agent-board.mjs'), echo)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(echo)}'] }]\n`)
  // Shown for a POSIX shell: single quotes, a quote inside written as '\''.
  const posix = f.run(pkg, ['--data-dir', root, '--print'], { NODE_OPTIONS: `--require ${JSON.stringify(join(repo, 'tests/fixtures/platform-posix.cjs'))}` })
  success(posix)
  assert.equal(posix.stdout, `update=${JSON.stringify(`npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir '${root.replaceAll("'", "'\\''")}'`)}`)
  // Shown on Windows: Command Prompt reads only double quotes and PowerShell runs $(...) and backticks inside them, so a path
  // with $ or a backtick is shown once per shell (a quote inside doubled for PowerShell); other paths keep one command.
  const windows = f.run(pkg, ['--data-dir', root, '--print'], { NODE_OPTIONS: `--require ${JSON.stringify(join(repo, 'tests/fixtures/platform-win32.cjs'))}` })
  success(windows)
  const base = `npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir`
  assert.equal(windows.stdout, `update=${JSON.stringify(`Command Prompt: ${base} "${root}"; PowerShell: ${base} '${root.replaceAll("'", "''")}'`)}`)
}))

test('on Windows each shown update command, run in its own shell, receives the exact path (review of #1328)', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, "data $HOME $(touch pwned) `tick` it's")
  const echo = `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\n// 0.24.2`
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'agent-board.mjs'), echo)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(echo)}'] }]\n`)
  const shown = f.run(pkg, ['--data-dir', root, '--print'], { NODE_OPTIONS: `--require ${JSON.stringify(join(repo, 'tests/fixtures/platform-win32.cjs'))}` })
  const lines = Object.fromEntries(shown.stderr.split(/\r?\n/).map(line => /^ {2}(Command Prompt|PowerShell): (.+)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]))
  assert.deepEqual(Object.keys(lines).sort(), ['Command Prompt', 'PowerShell'], shown.stderr)
  // A stand-in npx that records the arguments it receives.
  const stub = join(f.box, 'stub')
  save(join(stub, 'npx.cmd'), `@"${process.execPath}" "%~dp0npx.js" %*\r\n`)
  save(join(stub, 'npx.js'), "require('node:fs').writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)))\n")
  const out = join(f.box, 'argv.json')
  const path = `${stub};${f.env.PATH ?? f.env.Path}`
  const env = { ...f.env, PATH: path, Path: path, STUB_OUT: out }
  const expected = [`${manifest.name}@${manifest.version}`, 'setup', '--agent', 'codex', '--data-dir', root]
  const shells = {
    'Command Prompt': command => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 }),
    PowerShell: command => spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 }),
  }
  for (const [shell, runIn] of Object.entries(shells)) {
    rmSync(out, { force: true })
    const result = runIn(lines[shell])
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), expected, shell)
  }
}))

test('the launcher hands an older script the update command for the install it runs and the plugin reconnect command (#1304)', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  const echo = head => `${head}process.stdout.write('update=' + JSON.stringify(process.env.AGENT_BOARD_UPDATE_COMMAND ?? null))\n// 0.24.2`
  const text = echo(`globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\n`)
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'agent-board.mjs'), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(text)}'] }]\n`)
  const custom = f.run(pkg, ['--data-dir', root, '--print'])
  success(custom)
  assert.equal(custom.stdout, `update=${JSON.stringify(`npx ${manifest.name}@${manifest.version} setup --agent codex --data-dir ${shellQuoted(root)}`)}`)
  const plugin = echo('globalThis.AGENT_BOARD = {}\n')
  const script = join(f.env.CLAUDE_CONFIG_DIR, 'agent-board.mjs')
  save(script, plugin)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.24.2', board: ['${bodyHash(plugin)}'] }]\n`)
  const fromPlugin = f.run(pkg, ['--print'])
  success(fromPlugin)
  assert.equal(fromPlugin.stdout, 'update="/progress connect"')
}))

test('the board script beside CLAUDE_PROGRESS_FILE runs with the arguments unchanged and its own path as argv[1]', () => fixture(f => {
  const pkg = packed(f)
  const script = join(f.home, 'plugin data/agent-board.mjs')
  const progress = join(dirname(script), 'progress.md')
  save(script, fake)
  save(boardPath(f), 'throw new Error("wrong board")\n')
  const args = ['--watch', '--lang', 'en', '--all']
  const result = f.run(pkg, args, { CLAUDE_PROGRESS_FILE: progress })
  success(result)
  assert.deepEqual(JSON.parse(result.stdout), { argv1: resolve(script), args })
  const explicit = join(f.home, 'explicit/agent-board.mjs')
  save(explicit, fake)
  const passed = ['--progress-file', join(dirname(explicit), 'other.md'), '--all']
  const selected = f.run(pkg, passed, { CLAUDE_PROGRESS_FILE: progress })
  success(selected)
  assert.deepEqual(JSON.parse(selected.stdout), { argv1: resolve(explicit), args: passed })
}))

test("with no independent install, the Claude plugin's board script beside its progress.md is used", () => fixture(f => {
  const pkg = packed(f)
  for (const config of [join(f.home, 'claude config'), '']) {
    const script = join(config || join(f.home, '.claude'), 'agent-board.mjs')
    save(script, fake)
    const result = f.run(pkg, ['--chat'], { CLAUDE_CONFIG_DIR: config })
    success(result)
    assert.deepEqual(JSON.parse(result.stdout), { argv1: resolve(script), args: ['--chat'] })
    assert.equal(result.stderr, '')
  }
}))

test('--data-dir picks the board script in that folder and is not passed on', () => fixture(f => {
  const pkg = packed(f)
  const data = join(f.home, 'chosen data')
  const script = join(data, 'agent-board.mjs')
  save(script, fake)
  save(boardPath(f), 'throw new Error("wrong board")\n')
  const result = f.run(pkg, ['--chat', '--data-dir', data, '--all'])
  success(result)
  assert.deepEqual(JSON.parse(result.stdout), { argv1: resolve(script), args: ['--chat', '--all'] })
  assert.equal(result.stderr, '')
  for (const args of [['--data-dir'], ['--data-dir', '--chat']]) {
    const invalid = f.run(pkg, args)
    assert.equal(invalid.status, 2)
    assert.equal(invalid.stderr, 'agent-board: --data-dir needs a folder.\n')
  }
  const absent = f.run(pkg, ['--data-dir', join(f.home, 'absent')])
  assert.equal(absent.status, 1)
  assert.equal(absent.stderr.includes(boardPath(f)), false)
  const explicit = join(f.home, 'explicit/agent-board.mjs')
  save(explicit, fake)
  const args = ['--progress-file', join(dirname(explicit), 'progress.md'), '--chat']
  const preferred = f.run(pkg, [...args, '--data-dir', data])
  success(preferred)
  assert.deepEqual(JSON.parse(preferred.stdout), { argv1: resolve(explicit), args })
}))

test('an unknown word prints the usage hint and exits 2', () => fixture(f => {
  const pkg = packed(f)
  const result = f.run(pkg, ['serve'])
  assert.ifError(result.error)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'agent-board: unknown command "serve". The board takes options such as --print or --json; run agent-board --help.\n')
  assert.deepEqual(filesUnder(f.home), [])
}))

test("the Claude plugin's copy of this exact build runs with no note", () => fixture(f => {
  const pkg = packed(f)
  const path = join(f.env.CLAUDE_CONFIG_DIR, 'progress.md')
  save(join(f.env.CLAUDE_CONFIG_DIR, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${bundle(pkg)}`)
  const result = f.run(pkg)
  success(result)
  assert.ok(result.stdout.trim())
  assert.equal(result.stderr, '')
}))

test('an older plugin copy is told to update the plugin, and an older independent install is told to preview setup', () => fixture(f => {
  const pkg = packed(f)
  const script = join(f.env.CLAUDE_CONFIG_DIR, 'agent-board.mjs')
  const text = `globalThis.AGENT_BOARD = ${JSON.stringify({ path: join(dirname(script), 'progress.md'), lang: 'en' })}\n${bundle(pkg)}\n// older`
  save(script, text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  const plugin = f.run(pkg)
  success(plugin)
  assert.equal(plugin.stderr, `agent-board ${manifest.version}: the board script at ${script} is from 0.0.1; the Claude Code plugin wrote it. To update it, update the agent-board plugin in Claude Code, then run /progress connect.\n`)
  assert.equal(plugin.stderr.includes('setup'), false)
  const root = join(f.home, 'data dir')
  save(join(root, 'install-cursor.json'), '{}')
  save(join(root, 'install-codex.json'), '{}')
  save(join(root, 'unrelated.json'), '{}')
  save(join(root, 'install-codex.backup.json'), '{}')
  save(join(root, 'install-unknown.json'), '{}')
  mkdirSync(join(root, 'install-grok.json'))
  save(join(root, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: root, lang: 'en' })}\n${text.slice(text.indexOf('\n') + 1)}`)
  for (const [lang, preview, apply] of [['en', 'To update it, preview:', ', then add --apply.'], ['zh-TW', '更新前先預覽：', '，再加上 --apply。'], ['zh-CN', '更新前先预览：', '，再加上 --apply。']]) {
    const result = f.run(pkg, ['--data-dir', root, '--lang', lang])
    success(result)
    assert.ok(result.stderr.includes(`${preview}${lang === 'en' ? ' ' : ''}npx ${manifest.name}@${manifest.version} setup --agent codex,cursor --data-dir ${shellQuoted(root)}${apply}`), result.stderr)
    assert.equal(result.stderr.includes('setup --apply'), false)
    assert.equal(result.stderr.trim().split('\n').length, 1)
  }
  const gone = join(f.home, 'moved')
  const other = join(f.home, 'other')
  save(join(other, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: gone, lang: 'en' })}\n${text.slice(text.indexOf('\n') + 1)}`)
  const moved = f.run(pkg, ['--data-dir', other])
  success(moved)
  assert.ok(moved.stderr.includes(`is from 0.0.1. To update it, preview: npx ${manifest.name}@${manifest.version} setup --data-dir `), moved.stderr)
  assert.ok(moved.stderr.includes(`--data-dir ${/[^\w.:\\/~@+,=-]/.test(other) ? shellQuoted(other) : other}, then add --apply.`), moved.stderr)
  assert.equal(moved.stderr.includes(gone), false)
  assert.equal(moved.stderr.includes('--agent'), false)
  assert.equal(moved.stderr.includes('could not compare'), false)
  assert.equal(moved.stderr.trim().split('\n').length, 1)
}))

test("--data-dir runs that folder's board without CLAUDE_PROGRESS_FILE", () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  const progress = join(f.home, 'plugin data/progress.md')
  const text = 'globalThis.AGENT_BOARD = {}\nprocess.stdout.write(JSON.stringify(process.env.CLAUDE_PROGRESS_FILE ?? null))\n'
  save(join(root, 'agent-board.mjs'), text)
  save(join(dirname(progress), 'agent-board.mjs'), text)
  const selected = f.run(pkg, ['--chat', '--data-dir', root], { CLAUDE_PROGRESS_FILE: progress })
  success(selected)
  assert.equal(selected.stderr, '')
  assert.equal(JSON.parse(selected.stdout), null)
  const inherited = f.run(pkg, ['--chat'], { CLAUDE_PROGRESS_FILE: progress })
  success(inherited)
  assert.equal(inherited.stderr, '')
  assert.equal(JSON.parse(inherited.stdout), progress)
}))

test('the launcher tells the board script which package version it runs from', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  save(join(root, 'agent-board.mjs'), 'globalThis.AGENT_BOARD = {}\nprocess.stdout.write(JSON.stringify(process.env.AGENT_BOARD_PACKAGE_VERSION ?? null))\n')
  const result = f.run(pkg, ['--chat', '--data-dir', root], { AGENT_BOARD_PACKAGE_VERSION: '0.0.0' })
  success(result)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout), manifest.version)
}))

test('agent-board setup with no agent found says how to name one, without a stack trace', () => fixture(f => {
  const pkg = packed(f)
  for (const [lang, hint, unknown] of [['en', 'Setup found no agent', '--agent named an agent setup does not know'], ['zh-TW', 'setup 在這台電腦沒有找到 agent', '--agent 寫了 setup 不認得的 agent 名稱'], ['zh-CN', 'setup 在这台电脑没有找到 agent', '--agent 写了 setup 不认识的 agent 名称']]) {
    for (const extra of [[], ['--agent', 'unknown']]) {
      const result = f.run(pkg, ['setup', '--home', f.home, '--lang', lang, ...extra])
      assert.ifError(result.error)
      assert.equal(result.status, extra.length ? 1 : 0)
      assert.equal(extra.length ? result.stdout : result.stderr, '')
      const text = extra.length ? result.stderr : result.stdout
      assert.ok(text.includes(extra.length ? unknown : hint), text)
      assert.ok(text.includes(`npx ${manifest.name} setup`) && text.includes('--agent codex'), text)
      assert.equal(text.includes('    at '), false)
      assert.equal(text.includes(pkg), false)
      assert.equal(text.trim().split('\n').length, 1)
      assert.deepEqual(filesUnder(f.home), [])
    }
  }
}))

test('agent-board setup with an option missing its value says so, without a stack trace', () => fixture(f => {
  const pkg = packed(f)
  for (const [lang, hint] of [['en', 'a setup option is missing its value'], ['zh-TW', 'setup 有個選項後面沒有接值'], ['zh-CN', 'setup 有个选项后面没有接值']]) {
    for (const extra of [['--agent'], ['--agent', 'codex', '--data-dir']]) {
      const result = f.run(pkg, ['setup', '--home', f.home, '--lang', lang, ...extra])
      assert.ifError(result.error)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(result.stderr.includes(hint), result.stderr)
      assert.equal(result.stderr.includes('found no agent'), false)
      assert.equal(result.stderr.includes('    at '), false)
      assert.equal(result.stderr.includes(pkg), false)
      assert.equal(result.stderr.trim().split('\n').length, 1)
      assert.deepEqual(filesUnder(f.home), [])
    }
  }
}))

test('a board ended by a signal ends the launcher the same way', { skip: process.platform === 'win32' && 'POSIX signals' }, () => fixture(f => {
  const pkg = packed(f)
  save(boardPath(f), 'globalThis.AGENT_BOARD = {}\nprocess.kill(process.pid, "SIGTERM")\n')
  const result = f.run(pkg, ['--chat'])
  assert.ifError(result.error)
  assert.equal(result.status, null)
  assert.equal(result.signal, 'SIGTERM')
}))

test("messages follow the board's saved language", () => fixture(f => {
  const pkg = packed(f)
  const script = boardPath(f)
  save(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ lang: 'zh-TW' })}\n${fake.slice(fake.indexOf('\n') + 1)}`)
  save(join(pkg, 'hooks/released.ts'), 'export const RELEASED = []\n')
  const note = `agent-board ${manifest.version}：${script} 的看板程式是另一個版本（較新，或被改過），照原樣執行。\n`
  for (const LANG of ['', 'en_US.UTF-8', 'zh_CN.UTF-8']) {
    const result = f.run(pkg, [], { LANG })
    success(result)
    assert.equal(result.stderr, note)
  }
  const explicit = f.run(pkg, ['--lang', 'zh-CN'], { LANG: '' })
  success(explicit)
  assert.equal(explicit.stderr, `agent-board ${manifest.version}：${script} 的看板程序是另一个版本（较新，或被改过），照原样运行。\n`)
  rmSync(join(pkg, 'hooks/board-script.ts'))
  const unreadable = f.run(pkg, [], { LANG: '' })
  success(unreadable)
  assert.equal(unreadable.stderr, `agent-board ${manifest.version}：無法比對 ${script} 的看板程式與這個套件（ENOENT），照原樣執行。\n`)
}))

test('npx guidance uses the package name while command examples keep the bin name', () => fixture(f => {
  const pkg = packed(f)
  const renamed = { ...manifest, name: '@example/renamed-board' }
  save(join(pkg, 'package.json'), `${JSON.stringify(renamed)}\n`)
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const help = f.run(pkg, ['--help', '--lang', lang])
    success(help)
    assert.ok(help.stdout.includes('agent-board setup --apply'))
    assert.ok(help.stdout.includes(`npx ${renamed.name} <`))
    const missing = f.run(pkg, ['--lang', lang])
    assert.equal(missing.status, 1)
    assert.ok(missing.stderr.includes(`npx ${renamed.name} setup --apply`))
    const setup = f.run(pkg, ['setup', '--home', f.home, '--lang', lang])
    assert.equal(setup.status, 0)
    assert.ok(setup.stdout.includes(`npx ${renamed.name} setup`) && setup.stdout.includes('--agent codex'), setup.stdout)
  }
  const text = `${prelude(f)}${fake.slice(fake.indexOf('\n') + 1)}`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  const old = f.run(pkg)
  success(old)
  assert.ok(old.stderr.includes(`npx ${renamed.name}@${manifest.version} setup, then add --apply.`))
}))

test('setup forwards stderr and exit status while hiding the package folder on failure', () => fixture(f => {
  const pkg = packed(f)
  const stderr = `native: ${pkg}\nforward: ${pkg.replaceAll('\\', '/')}\nagain: ${pkg}\n`
  for (const status of [0, 7]) {
    save(join(pkg, 'scripts/setup-agent.mjs'), `process.stderr.write(${JSON.stringify(stderr)})\nprocess.exit(${status})\n`)
    const result = f.run(pkg, ['setup', '--home', f.home])
    assert.ifError(result.error)
    assert.equal(result.status, status)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, status === 0 ? stderr : 'native: <agent-board package>\nforward: <agent-board package>\nagain: <agent-board package>\n')
    assert.deepEqual(filesUnder(f.home), [])
  }
}))

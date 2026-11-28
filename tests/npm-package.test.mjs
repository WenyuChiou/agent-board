import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bundleFiles, bundleFromDir } from '../scripts/bundle-text.mjs'
import { privateRuntimeFolder, writePrivateRuntimeFile } from '../scripts/runtime-folder.ts'
import { setupPrograms } from './helpers/setup-programs.mjs'
import { readPrintedLink } from './helpers/printed-link.mjs'
import { EN } from '../hooks/strings-en.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin/plugin.json'), 'utf8'))
const save = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const filesUnder = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? filesUnder(path) : [path]
}).sort()
const makeBox = () => {
  const box = mkdtempSync(join(tmpdir(), 'agent-board npm-'))
  const home = join(box, 'home')
  const tmp = join(box, 'tmp')
  const cache = join(box, 'npm-cache')
  for (const dir of [home, tmp, cache]) mkdirSync(dir)
  // Over SSH the launcher prints the forward note before the link (#1283); the launchers here run
  // on this computer, so the two variables of the person's own terminal are left out (#1970).
  const { SSH_CONNECTION: _sshConnection, SSH_TTY: _sshTty, ...outer } = process.env
  const env = {
    ...outer,
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
  const cleanup = () => {
    try {
      rmSync(box, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 })
    } catch {
      // Windows transient file lock
    }
  }
  return { box, home, tmp, env, run, cleanup }
}
const fixture = fn => {
  const f = makeBox()
  try { return fn(f) }
  finally { f.cleanup() }
}
const asyncFixture = async fn => {
  const f = makeBox()
  try { return await fn(f) }
  finally { f.cleanup() }
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

// The language flags moved from the Quick start bullets to the setup guide, which every Quick start links.
test('the setup guide says how to choose the language, and every Quick start links it', () => {
  const setup = readFileSync(join(repo, 'docs/SETUP.md'), 'utf8')
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.ok(setup.includes(`--lang ${language}`), `SETUP.md explains --lang ${language}`)
  for (const [file, heading] of [['README.md', 'Quick start'], ['README.zh-TW.md', '快速開始'], ['README.zh-CN.md', '快速开始']]) {
    const section = readFileSync(join(repo, file), 'utf8').split(`## ${heading}`)[1]?.split('\n## ')[0]
    assert.ok(section, `${file} has its Quick start section`)
    assert.ok(section.includes('docs/SETUP.md#after-setup-per-agent'), `${file} links the setup guide`)
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

test('--data-dir selects the explicit installation and preserves its root for the board', () => fixture(f => {
  const pkg = packed(f)
  const data = join(f.home, 'chosen data')
  const script = join(data, 'agent-board.mjs')
  save(script, fake)
  save(boardPath(f), 'throw new Error("wrong board")\n')
  const result = f.run(pkg, ['--chat', '--data-dir', data, '--all'])
  success(result)
  assert.deepEqual(JSON.parse(result.stdout), { argv1: resolve(script), args: ['--chat', '--all', '--data-dir', data] })
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
  assert.deepEqual(JSON.parse(preferred.stdout), { argv1: resolve(script), args: [...args, '--data-dir', data] })
  const progressOnly = f.run(pkg, args)
  success(progressOnly)
  assert.deepEqual(JSON.parse(progressOnly.stdout), { argv1: resolve(explicit), args })
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
    assert.ok(result.stderr.includes(`${preview}${lang === 'en' ? ' ' : ''}npx ${manifest.name}@${manifest.version} setup --agent codex,cursor --data-dir "${root}"${apply}`), result.stderr)
    assert.equal(result.stderr.includes('setup --apply'), false)
    assert.equal(result.stderr.trim().split('\n').length, 1)
  }
  const gone = join(f.home, 'moved')
  const other = join(f.home, 'other')
  save(join(other, 'agent-board.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ codexRoot: gone, lang: 'en' })}\n${text.slice(text.indexOf('\n') + 1)}`)
  const moved = f.run(pkg, ['--data-dir', other])
  success(moved)
  assert.ok(moved.stderr.includes(`is from 0.0.1. To update it, preview: npx ${manifest.name}@${manifest.version} setup --data-dir `), moved.stderr)
  assert.ok(moved.stderr.includes(`--data-dir ${/[^\w.:\\/~@+,=-]/.test(other) ? `"${other}"` : other}, then add --apply.`), moved.stderr)
  assert.equal(moved.stderr.includes(gone), false)
  assert.equal(moved.stderr.includes('--agent'), false)
  assert.equal(moved.stderr.includes('could not compare'), false)
  assert.equal(moved.stderr.trim().split('\n').length, 1)
}))

// #1314: an install that setup wrote in a data folder, whose board script an earlier release wrote and recorded as
// setup's own, before the release that added the new uses.
const olderInstall = (f, agent = 'opencode', extra = []) => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  success(f.run(pkg, ['setup', '--agent', agent, '--data-dir', root, ...extra, '--apply']))
  const script = join(root, 'agent-board.mjs'), record = join(root, `install-${agent}.json`)
  const text = `${readFileSync(script, 'utf8')}\n// older\n`
  save(script, text)
  const owned = JSON.parse(readFileSync(record, 'utf8'))
  for (const file of Object.keys(owned.files)) if (resolve(file) === resolve(script)) owned.files[file] = createHash('sha256').update(text).digest('hex')
  delete owned.version
  save(record, `${JSON.stringify(owned, null, 2)}\n`)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  return { pkg, root, script, record, text }
}

// #1314: a person who opens the board in a terminal through an older setup-installed script gets the update itself,
// with setup's one question, in the install root the script names; no command to copy.
test('the launcher finds an older installed script and starts setup --update with its roots', () => fixture(f => {
  const { pkg, root, script, record } = olderInstall(f)
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), 'y\n')
  success(result)
  assert.equal(result.stdout.split('[y/N]').length - 1, 1, result.stdout)
  assert.match(result.stdout, /Code your agents run changes: .*agent-board\.mjs/, result.stdout)
  for (const unshipped of ['"Check for new versions"', 'the list of your Codex sessions']) assert.equal(result.stdout.includes(unshipped), false, result.stdout)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "the update wrote this package's board script")
  assert.equal(typeof JSON.parse(readFileSync(record, 'utf8')).version, 'string', 'the record names the version')
  assert.ok(result.stdout.split('Agent Board updated to')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the update\n${result.stdout}`)
  assert.equal(result.stderr.includes('To update it, preview'), false, result.stderr)
  // The install lock always sits in ~/.agent-board; no file of the install goes there.
  assert.deepEqual(existsSync(join(f.home, '.agent-board')) ? filesUnder(join(f.home, '.agent-board')) : [], [], 'the update stayed in the install root')
}))

// #1314, #1802: declining is not an error for the board: the script stays as it was, setup already printed how to
// update with --update, so the duplicate preview/--apply notice is not printed in the same run, and the board still opens.
test('a person who declines the launcher\'s update keeps the older script and the board still opens', () => fixture(f => {
  const { pkg, root, script, record, text } = olderInstall(f)
  for (const input of ['n\n', '']) {
    const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), input)
    success(result)
    assert.equal(result.stdout.split('[y/N]').length - 1, 1, result.stdout)
    assert.equal(readFileSync(script, 'utf8'), text, 'the older script is left as it was')
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).version, undefined, 'the record is left as it was')
    const updateLines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(line => /\bTo update\b/.test(line))
    assert.equal(updateLines.length, 1, `declining prints exactly one update line\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(updateLines[0], /^Nothing changed\. To update, run this in a terminal and answer y: .* --update/)
    assert.equal(updateLines[0].includes('--from-launcher'), false, updateLines[0])
    assert.equal(result.stderr.includes('To update it, preview'), false, `a declined update skips the duplicate preview notice\n${result.stderr}`)
    assert.equal(result.stderr, '', `unexpected stderr on declined update\n${result.stderr}`)
    assert.ok(result.stdout.split('Nothing changed.')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the answer\n${result.stdout}`)
  }
}))

// #1802: the launcher tells setup `--update` via `--from-launcher` (never via env), and setup strips that flag
// before starting its helper, the Codex bootstrap board, or any other child.
test('the launcher passes --from-launcher to setup --update only, without leaking it to setup\'s children or the board', () => fixture(f => {
  const { pkg, root, script } = olderInstall(f)
  const terminal = terminalLauncher(f)
  const logFile = join(f.box, 'child-spy.jsonl')
  const spy = join(f.box, 'child-spy.cjs')
  save(logFile, '')
  save(spy, `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ script: process.argv[1] || '', argv: process.argv.slice(2), launcherEnv: Object.keys(process.env).filter(k => /LAUNCHER/i.test(k)) }) + '\\n')\n`)
  const spyEnv = { ...terminal, NODE_OPTIONS: `${terminal.NODE_OPTIONS} --require ${JSON.stringify(spy)}` }
  const takeSpy = () => {
    const events = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    writeFileSync(logFile, '')
    return events
  }
  const assertIsolated = (events, label) => {
    for (const entry of events.filter(one => !/[\\/]setup-agent\.mjs$/.test(one.script))) {
      assert.equal(entry.argv.includes('--from-launcher'), false, `${label}: --from-launcher leaked to ${entry.script}: ${JSON.stringify(entry.argv)}`)
      assert.deepEqual(entry.launcherEnv, [], `${label}: launcher env leaked to ${entry.script}: ${JSON.stringify(entry.launcherEnv)}`)
    }
  }
  const declined = f.run(pkg, ['--data-dir', root, '--print'], spyEnv, 'n\n')
  success(declined)
  assert.equal(`${declined.stdout}\n${declined.stderr}`.split(/\r?\n/).filter(line => /\bTo update\b/.test(line)).length, 1, `${declined.stdout}\n${declined.stderr}`)
  assert.equal(declined.stderr, '', declined.stderr)
  const declineEvents = takeSpy()
  const setupDecline = declineEvents.filter(one => /[\\/]setup-agent\.mjs$/.test(one.script))
  assert.equal(setupDecline.length, 1, JSON.stringify(declineEvents))
  assert.ok(setupDecline[0].argv.includes('--update') && setupDecline[0].argv.includes('--from-launcher'), JSON.stringify(setupDecline[0]))
  assert.deepEqual(setupDecline[0].launcherEnv, [])
  assert.ok(declineEvents.some(one => /[\\/]setup-codex\.mjs$/.test(one.script)), 'preview helper ran')
  assert.ok(declineEvents.some(one => one.argv.includes('--codex-setup')), 'bootstrap board ran for preview')
  assert.equal(declineEvents.filter(one => resolve(one.script) === resolve(script)).length, 1, 'installed board opened')
  assertIsolated(declineEvents, 'declined')

  // Even with the old env variable set externally, direct `setup --update` without `--from-launcher` still exits 1 on decline.
  const direct = f.run(pkg, ['setup', '--update', '--agent', 'opencode', '--data-dir', root], { AGENT_BOARD_SETUP_TTY: '1', AGENT_BOARD_TEST_PID: String(process.pid), AGENT_BOARD_LAUNCHER_UPDATE: '1' }, 'n\n')
  assert.ifError(direct.error)
  assert.equal(direct.status, 1, direct.stderr)
  takeSpy()

  const accepted = f.run(pkg, ['--data-dir', root, '--print'], spyEnv, 'y\n')
  success(accepted)
  const acceptEvents = takeSpy()
  assert.ok(acceptEvents.some(one => /[\\/]setup-codex\.mjs$/.test(one.script) && one.argv.includes('--apply')), 'apply helper ran')
  assert.ok(acceptEvents.some(one => one.argv.includes('--codex-setup') && one.argv.includes('--apply')), 'bootstrap board ran for apply')
  assert.equal(acceptEvents.filter(one => resolve(one.script) === resolve(script)).length, 1, 'updated board opened')
  assertIsolated(acceptEvents, 'accepted')
}))

// #1314: Ctrl-C at setup's question stops the launcher too, so no board opens behind it. On Windows a process that stops
// itself reports an exit status, not a signal, so the case runs on the other systems.
test('a launcher whose update is stopped by a signal stops with it and opens no board', { skip: process.platform === 'win32' && 'Windows reports no signal here' }, () => fixture(f => {
  const { pkg, root, script, text } = olderInstall(f)
  // A stand-in for setup that Ctrl-C stops while it asks.
  save(join(pkg, 'scripts/setup-agent.mjs'), "process.kill(process.pid, 'SIGINT')\n")
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), '')
  assert.equal(result.signal, 'SIGINT', `status ${result.status}\n${result.stderr}`)
  assert.equal(result.stdout, '', 'no board opened')
  assert.equal(readFileSync(script, 'utf8'), text, 'the older script is left as it was')
}))

// #1783: Gemini CLI is retired and setup refuses it by name. A Gemini record an earlier release left in the install
// root must not stop the launcher's update of the agents setup still installs.
test('an older install that keeps a Gemini record from an earlier release still updates its other agents from the launcher', () => fixture(f => {
  const { pkg, root, script, record } = olderInstall(f)
  const gemini = join(root, 'install-gemini.json')
  save(gemini, '{"files":{}}\n')
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), 'y\n')
  success(result)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), `the update wrote this package's board script\n${result.stdout}\n${result.stderr}`)
  assert.equal(typeof JSON.parse(readFileSync(record, 'utf8')).version, 'string', 'the record names the version')
  assert.equal(readFileSync(gemini, 'utf8'), '{"files":{}}\n', 'the Gemini record stays for a removal')
}))

// #1783: only opening the board starts setup. `stop` stops as before, with the notice; a setup that cannot start
// leaves the notice and the board opens; opening the board afterwards updates it.
test('in a terminal, stop and a setup that cannot start keep the older script with the notice, and opening the board updates it', () => fixture(f => {
  const { pkg, root, script, text } = olderInstall(f)
  const terminal = terminalLauncher(f)
  const stopped = f.run(pkg, ['stop', '--data-dir', root], terminal, 'y\n')
  assert.ifError(stopped.error)
  assert.equal(stopped.stdout.includes('[y/N]'), false, `stop asked setup's question\n${stopped.stdout}`)
  assert.ok(stopped.stderr.includes('To update it, preview'), stopped.stderr)
  assert.equal(readFileSync(script, 'utf8'), text, 'stop left the older script as it was')
  // A bare `--lang` does not make the next flag its language: `--lang --stop` still stops, without setup (#1783).
  const bare = f.run(pkg, ['--lang', '--stop', '--data-dir', root], terminal, 'y\n')
  assert.ifError(bare.error)
  assert.equal(bare.stdout.includes('[y/N]'), false, `--lang --stop asked setup's question\n${bare.stdout}`)
  assert.ok(bare.stderr.includes('To update it, preview'), bare.stderr)
  assert.equal(readFileSync(script, 'utf8'), text, '--lang --stop left the older script as it was')
  // A stand-in for a system that cannot start one more process (EAGAIN) when the launcher starts setup.
  const failing = join(f.box, 'no-setup.cjs')
  save(failing, `if (/[\\\\/]bin[\\\\/]agent-board\\.mjs$/.test(process.argv[1] || '')) { const cp = require('node:child_process'); const real = cp.spawnSync; cp.spawnSync = (file, list, options) => /setup-agent\\.mjs$/.test((list || [])[0] || '') ? { pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null, error: Object.assign(new Error('spawnSync EAGAIN'), { code: 'EAGAIN' }) } : real(file, list, options); require('node:module').syncBuiltinESMExports() }\n`)
  const blocked = f.run(pkg, ['--data-dir', root, '--print'], { ...terminal, NODE_OPTIONS: `${terminal.NODE_OPTIONS} --require ${JSON.stringify(failing)}` }, 'y\n')
  success(blocked)
  assert.ok(blocked.stderr.includes('To update it, preview'), `no notice after setup could not start\n${blocked.stderr}`)
  assert.ok(blocked.stdout.trim(), 'the board opened')
  assert.equal(readFileSync(script, 'utf8'), text, 'the older script is left as it was')
  const opened = f.run(pkg, ['--data-dir', root, '--print'], terminal, 'y\n')
  success(opened)
  assert.equal(opened.stdout.split('[y/N]').length - 1, 1, opened.stdout)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "opening the board wrote this package's board script")
}))

// #1783: every option that opens the board counts, with the value it takes; `--lan` takes the next word only when it
// is an address, as the board reads it.
test('the launcher\'s update runs for the view options that take no value', () => fixture(f => {
  const { pkg, root, script, record, text } = olderInstall(f)
  const terminal = terminalLauncher(f)
  // Each list of views with no value asks once; declined, the script stays as it was and the board opens on it.
  for (const list of [['--print', '--all', '--plain'], ['--print', '--no-color', '--quiet-board']]) {
    const declined = f.run(pkg, ['--data-dir', root, ...list], terminal, 'n\n')
    success(declined)
    assert.equal(declined.stdout.split('[y/N]').length - 1, 1, `${list.join(' ')} did not ask once\n${declined.stdout}\n${declined.stderr}`)
    assert.equal(readFileSync(script, 'utf8'), text, `${list.join(' ')}: declined, the older script is left as it was`)
    assert.equal(declined.stderr.includes('To update it, preview'), false, `${list.join(' ')}: ${declined.stderr}`)
    assert.ok(declined.stdout.split('Nothing changed.')[1]?.split('\n').slice(1).join('\n').trim(), `${list.join(' ')}: the board opened after the answer\n${declined.stdout}`)
  }
  const result = f.run(pkg, ['--data-dir', root, '--print', '--lan', '--no-open'], terminal, 'y\n')
  success(result)
  assert.equal(result.stdout.split('[y/N]').length - 1, 1, `${result.stdout}\n${result.stderr}`)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "the update wrote this package's board script")
  assert.equal(typeof JSON.parse(readFileSync(record, 'utf8')).version, 'string', 'the record names the version')
  assert.equal(result.stderr.includes('To update it, preview'), false, result.stderr)
  assert.ok(result.stdout.split('Agent Board updated to')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the update\n${result.stdout}`)
}))

// #1789: a view option that takes a valid value asks once in a terminal; declined, the script stays without the
// duplicate notice and the board opens; accepted, the update runs and the board opens.
test('the launcher\'s update runs for every view option that takes a value', () => fixture(f => {
  const { pkg, root, script, record, text } = olderInstall(f)
  const terminal = terminalLauncher(f)
  for (const list of [
    ['--print', '--idle-minutes', '0.02'],
    ['--print', '--lang', 'auto'],
    ['--print', '--lang', 'fr'],
    ['--print', '--theme', 'dark', '--quiet-board'],
  ]) {
    const declined = f.run(pkg, ['--data-dir', root, ...list], terminal, 'n\n')
    success(declined)
    assert.equal(declined.stdout.split('[y/N]').length - 1, 1, `${list.join(' ')} did not ask once\n${declined.stdout}\n${declined.stderr}`)
    assert.equal(readFileSync(script, 'utf8'), text, `${list.join(' ')}: declined, the older script is left as it was`)
    assert.equal(declined.stderr.includes('To update it, preview'), false, `${list.join(' ')}: ${declined.stderr}`)
    assert.ok(declined.stdout.split('Nothing changed.')[1]?.split('\n').slice(1).join('\n').trim(), `${list.join(' ')}: the board opened after the answer\n${declined.stdout}`)
  }
  const accepted = f.run(pkg, ['--data-dir', root, '--print', '--lan', '10.0.0.5', '--port', '8080', '--idle-minutes', '30', '--lang', 'en'], terminal, 'y\n')
  success(accepted)
  assert.equal(accepted.stdout.split('[y/N]').length - 1, 1, `${accepted.stdout}\n${accepted.stderr}`)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "the update wrote this package's board script")
  assert.equal(typeof JSON.parse(readFileSync(record, 'utf8')).version, 'string', 'the record names the version')
  assert.equal(accepted.stderr.includes('To update it, preview'), false, accepted.stderr)
  assert.ok(accepted.stdout.split('Agent Board updated to')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the update\n${accepted.stdout}`)
}))

// #1783, #1789: a view option with an invalid or missing value, any option that is not a view, `--` and any other
// word keep the notice and start no setup. A plain view afterwards still updates.
test('an invalid view value, or any word that is not a view, keeps the notice and starts no setup', () => fixture(f => {
  const { pkg, root, script, text } = olderInstall(f)
  const terminal = terminalLauncher(f)
  const lists = [
    ['--html', '--port', '0'], ['--print', '--port', '70000'], ['--print', '--port', '08080'], ['--print', '--port'], ['--port', '--print'],
    ['--print', '--idle-minutes', '600000'], ['--print', '--idle-minutes', '-1'], ['--print', '--idle-minutes', 'soon'], ['--print', '--idle-minutes'],
    ['--print', '--lang'], ['--print', '--lang', '-x'], ['--print', '--theme'], ['--print', '--theme', '--quiet-board'],
    ['--print', '--days', '3'], ['--print', '--'],
  ].map(list => ['--data-dir', root, ...list])
  // The folder selector between a value option (or --lan with an address) and its value must not be stripped before checking.
  lists.push(
    ['--port', '--data-dir', root, '8080', '--print'],
    ['--lang', '--data-dir', root, 'en', '--print'],
    ['--theme', '--data-dir', root, 'dark', '--print'],
    ['--lan', '--data-dir', root, '10.0.0.5', '--print'],
  )
  for (const list of lists) {
    const shown = list.map(word => word === root ? '<root>' : word).join(' ')
    const result = f.run(pkg, list, terminal, 'y\n')
    assert.ifError(result.error)
    assert.equal(result.stdout.includes('[y/N]'), false, `${shown} asked setup's question\n${result.stdout}`)
    assert.ok(result.stderr.includes('To update it, preview'), `${shown}: ${result.stderr}`)
    assert.equal(readFileSync(script, 'utf8'), text, `${shown} left the older script as it was`)
  }
  const opened = f.run(pkg, ['--data-dir', root, '--print'], terminal, 'y\n')
  success(opened)
  assert.equal(opened.stdout.split('[y/N]').length - 1, 1, opened.stdout)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "the plain view wrote this package's board script")
}))

// #1783, #1789: the launcher's lists of options that open the board are kept against the board's own option grammar,
// so an option added to the board is classified here before it can start, or fail to start, the update.
test('every board option is classified as a view or not, and the view list is pinned', () => {
  const cli = readFileSync(join(repo, 'scripts/board-cli.ts'), 'utf8')
  const set = name => {
    const body = cli.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`))?.[1]
    assert.ok(body, `${name} in scripts/board-cli.ts`)
    return [...body.matchAll(/'(-[^']+)'/g)].map(one => one[1])
  }
  const board = new Set([...set('BOOL_FLAGS'), ...set('VALUE_FLAGS'), '--days', '--lan'])
  const launcher = readFileSync(join(repo, 'bin/agent-board.mjs'), 'utf8')
  const readLauncherSet = name => {
    const body = launcher.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`))?.[1]
    assert.ok(body, `${name} in bin/agent-board.mjs`)
    return [...body.matchAll(/'(-[^']+)'/g)].map(one => one[1])
  }
  const views = readLauncherSet('boardViews')
  const valueViews = readLauncherSet('boardValueViews')
  assert.deepEqual(views.sort(), ['--all', '--html', '--lan', '--no-color', '--no-open', '--plain', '--print', '--quiet-board', '--serve', '--watch'])
  assert.deepEqual(valueViews.sort(), ['--idle-minutes', '--lang', '--port', '--theme'])
  assert.deepEqual(views.filter(option => valueViews.includes(option)), [], 'flag views and value views do not overlap')
  // Not views: data reads, scripted keys, page server behaviour, actions, reports, management and internal flags, the
  // folders setup and the launcher choose, and `--progress-file`, which picks the board.
  const notViews = [
    '--json', '--days', '--project', '--keys', '--stale-ms', '--allow-resume', '--codex-send', '--no-codex-send', '--cwd', '--home',
    '--chat', '--status', '--tidy', '--mcp', '--report', '--stop', '--help', '-h', '--version', '-v', '--stopped', '--unsent',
    '--agent-status', '--apply', '--awaits-ack', '--check-conflicts', '--remove', '--update', '--antigravity-sidecar', '--hooks-approved',
    '--codex-doctor', '--codex-event', '--codex-remove', '--codex-report', '--codex-setup', '--codex-trust', '--hermes-trust', '--plan-event',
    '--recover-hooks', '--hook-recovery-parent', '--serve-child',
    '--agent', '--codex-bin', '--codex-dir', '--data-dir', '--deepseek-dir', '--event', '--grok-dir', '--hermes-dir', '--hook-deadline',
    '--hook-event', '--hook-started', '--id', '--legacy-connect-request', '--mailbox', '--messages-dir', '--nonce', '--older', '--openclaw-dir',
    '--opencode-dir', '--progress-file', '--ready-file', '--recovery-owner-created', '--recovery-owner-pid', '--recovery-owner-token',
    '--recovery-previous-token', '--ref', '--removing', '--session', '--setup-version', '--state', '--summary-b64', '--surface',
  ]
  const allViews = new Set([...views, ...valueViews])
  assert.deepEqual(notViews.filter(option => allViews.has(option)), [], 'views and notViews do not overlap')
  assert.deepEqual([...board].filter(option => !allViews.has(option) && !notViews.includes(option)), [], 'every board option is a view or named as not one')
  assert.deepEqual([...allViews].filter(option => !board.has(option)), [], 'every view is a board option')
  assert.deepEqual(notViews.filter(option => !board.has(option)), [], 'every name in the not-a-view list is a board option')
})

// #1783: the launcher has already chosen the board, so CLAUDE_PROGRESS_FILE, which may name another board, does not
// reach the update: setup keeps the progress file the install's own record names.
test('the launcher\'s update keeps the install\'s own progress file when CLAUDE_PROGRESS_FILE names another board', () => fixture(f => {
  const { pkg, root, script, record } = olderInstall(f)
  const own = JSON.parse(readFileSync(record, 'utf8')).progress
  assert.equal(typeof own, 'string', 'the record names its progress file')
  const other = join(f.home, 'other board', 'progress.md')
  save(other, '')
  const result = f.run(pkg, ['--data-dir', root, '--print'], { ...terminalLauncher(f), CLAUDE_PROGRESS_FILE: other }, 'y\n')
  success(result)
  assert.equal(result.stdout.split('[y/N]').length - 1, 1, `${result.stdout}\n${result.stderr}`)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), `the update wrote this package's board script\n${result.stdout}\n${result.stderr}`)
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).progress, own, 'the record keeps its own progress file')
  assert.equal(readFileSync(script, 'utf8').includes(JSON.stringify(other).slice(1, -1)), false, 'the script does not name the other board')
  assert.equal(JSON.parse(readFileSync(script, 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')).path, own, "the script's progress path is the install's own")
  assert.equal(readFileSync(other, 'utf8'), '', 'the other board is untouched')
  assert.ok(result.stdout.split('Agent Board updated to')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the update\n${result.stdout}`)
}))

// #1783: the update the launcher starts reaches only an install laid out as setup lays it out now (#1790). Codex and
// Grok installed in another folder than the one setup picks now keep the notice, a relative recorded folder too; in
// the folder CODEX_HOME or GROK_HOME names, the update runs and keeps them there. That folder's name starts with `..`,
// which is still a folder inside the home.
const keptHostFolder = (f, agent, variable, tail) => {
  const installed = join(f.home, `..${agent} folder`), other = join(f.home, `another ${agent} folder`)
  const { pkg, root, script, record, text } = olderInstall(f, agent, [`--${agent}-dir`, installed])
  const config = join(installed, ...tail)
  const owned = readFileSync(record, 'utf8')
  assert.equal(resolve(JSON.parse(owned).config), resolve(config), 'the record names the folder setup was given')
  mkdirSync(other, { recursive: true })
  const notice = (env, why) => {
    const result = f.run(pkg, ['--data-dir', root, '--print'], { ...terminalLauncher(f), ...env }, 'y\n')
    assert.ifError(result.error)
    assert.equal(result.stdout.includes('[y/N]'), false, `${why}: setup asked\n${result.stdout}`)
    assert.ok(result.stderr.includes('To update it, preview'), `${why}: ${result.stderr}`)
    assert.equal(readFileSync(script, 'utf8'), text, `${why}: the older script is left as it was`)
  }
  notice({ [variable]: other }, `${variable} names another folder`)
  notice({ [variable]: '' }, 'the usual folder is another')
  save(record, `${JSON.stringify({ ...JSON.parse(owned), config: relative(f.box, config) }, null, 2)}\n`)
  notice({ [variable]: installed }, 'the record names a relative folder')
  save(record, owned)
  assert.deepEqual(filesUnder(other), [], `nothing was written in the folder ${variable} names`)
  const result = f.run(pkg, ['--data-dir', root, '--print'], { ...terminalLauncher(f), [variable]: installed }, 'y\n')
  success(result)
  assert.equal(result.stdout.split('[y/N]').length - 1, 1, `${result.stdout}\n${result.stderr}`)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), `the update wrote this package's board script\n${result.stdout}\n${result.stderr}`)
  assert.equal(resolve(JSON.parse(readFileSync(record, 'utf8')).config), resolve(config), 'the record still names that folder')
  assert.ok(readFileSync(config, 'utf8').includes('agent-board'), 'the hooks stay in that folder')
  assert.match(result.stdout.split('[y/N]')[1] ?? '', /Progress/, `the board opened after the update\n${result.stdout}`)
  // Without a Codex program setup's trust step fails after the files are written: the script is new, so no notice.
  assert.equal(result.stderr.includes('To update it, preview'), false, `the updated script gets no notice\n${result.stderr}`)
}

test('the launcher\'s update reaches a Codex install only in the folder setup picks now, and keeps it there', () => fixture(f => keptHostFolder(f, 'codex', 'CODEX_HOME', ['hooks.json'])))

test('the launcher\'s update reaches a Grok install only in the folder setup picks now, and keeps it there', () => fixture(f => keptHostFolder(f, 'grok', 'GROK_HOME', ['hooks', 'agent-board-local.json'])))

// #1783: an install made for another home (`setup --home`) keeps the notice from this home, whose setup would not know
// that home (#1790); from that home, the update runs.
test('the launcher\'s update reaches an install made for another home only from that home', () => fixture(f => {
  const other = join(f.box, 'another home')
  mkdirSync(other, { recursive: true })
  const { pkg, root, script, text } = olderInstall(f, 'cursor', ['--home', other])
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), 'y\n')
  assert.ifError(result.error)
  assert.equal(result.stdout.includes('[y/N]'), false, `setup asked from this home\n${result.stdout}`)
  assert.ok(result.stderr.includes('To update it, preview'), result.stderr)
  assert.equal(readFileSync(script, 'utf8'), text, 'the older script is left as it was')
  const there = f.run(pkg, ['--data-dir', root, '--print'], { ...terminalLauncher(f), HOME: other, USERPROFILE: other }, 'y\n')
  success(there)
  assert.equal(there.stdout.split('[y/N]').length - 1, 1, `${there.stdout}\n${there.stderr}`)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), `from that home the update wrote this package's board script\n${there.stdout}\n${there.stderr}`)
}))

// #1783: an install made for a home inside this one passes the layout check, but setup run from here does not know that
// home and leaves the install as it was: the notice names the command, as for any other home (#1790).
test('an install made for a home inside this one keeps the older script and prints the notice', () => fixture(f => {
  const other = join(f.home, 'nested home')
  mkdirSync(other, { recursive: true })
  const { pkg, root, script, text } = olderInstall(f, 'cursor', ['--home', other])
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), 'y\n')
  assert.ifError(result.error)
  assert.equal(readFileSync(script, 'utf8'), text, `the older script is left as it was\n${result.stdout}\n${result.stderr}`)
  assert.ok(result.stderr.includes('To update it, preview'), `the notice names the command\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Progress/, `the board opened\n${result.stdout}`)
}))

test('--json through an older script prints the notice on stderr and exits 1', () => fixture(f => {
  const pkg = packed(f)
  // An older installed script that prints the text board, as a released 0.24.2 script would:
  // --json must not hand that text to an agent that expects JSON.
  const text = `${prelude(f)}process.stdout.write('the text board\\n')\n`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  const result = f.run(pkg, ['--json'])
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim().split('\n').length, 1)
  assert.ok(result.stderr.includes('is from 0.0.1.'), result.stderr)
  assert.ok(result.stderr.includes(`npx ${manifest.name}@${manifest.version} setup, then add --apply.`), result.stderr)
}))

test('--json with --chat or --status through an older script prints the notice on stderr and exits 1', () => fixture(f => {
  const pkg = packed(f)
  // The same text-printing older script, read with a mixed output flag: the launcher must
  // still fail with the notice instead of handing the text board to an agent that expects JSON.
  const text = `${prelude(f)}process.stdout.write('the text board\\n')\n`
  save(boardPath(f), text)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  for (const args of [['--json', '--chat'], ['--chat', '--json'], ['--json', '--status'], ['--status', '--json']]) {
    const result = f.run(pkg, args)
    assert.ifError(result.error)
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '', args.join(' '))
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
    assert.ok(result.stderr.includes('is from 0.0.1.'), result.stderr)
    assert.ok(result.stderr.includes(`npx ${manifest.name}@${manifest.version} setup, then add --apply.`), result.stderr)
  }
  // Without --json the old text behaviour is unchanged: --chat and --status still run the script.
  for (const args of [['--chat'], ['--status']]) {
    const result = f.run(pkg, args)
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, 'the text board\n', args.join(' '))
  }
}))

test('management commands with --json through an older script return JSON and exit 0, while a board read still exits 1', () => fixture(f => {
  const pkg = packed(f)
  // An older script that answers its management commands with JSON, as a released 0.24.2
  // script does, and prints the text board for a board read: the guard ends JSON board
  // reads only, so a management command still runs and still returns its JSON, with the
  // older-script notice on stderr as on main. The board-read half pins the other side of
  // that scope: a test that only checked the management commands would also pass with the
  // guard deleted outright, and it is the board-read half that fails on the merge base.
  const script = `${prelude(f)}const args = process.argv.slice(2)\n` +
    `process.stdout.write(args.includes('--codex-doctor') ? '{"doctor":"ok"}\\n' : args.includes('--codex-remove') ? '{"remove":"preview"}\\n' : 'the text board\\n')\n`
  save(boardPath(f), script)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(script)}'] }]\n`)
  for (const args of [['--codex-doctor', '--json'], ['--json', '--codex-doctor'], ['--codex-remove', '--json'], ['--json', '--codex-remove']]) {
    const result = f.run(pkg, args)
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.doesNotThrow(() => JSON.parse(result.stdout), `${args.join(' ')}: ${result.stdout}`)
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr)
    assert.ok(result.stderr.includes('is from 0.0.1.'), result.stderr)
  }
  // The guard still ends a plain JSON board read through the same older script.
  const read = f.run(pkg, ['--json'])
  assert.ifError(read.error)
  assert.equal(read.status, 1, read.stderr)
  assert.equal(read.stdout, '')
  assert.equal(read.stderr.trim().split('\n').length, 1, read.stderr)
  assert.ok(read.stderr.includes('is from 0.0.1.'), read.stderr)
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

// A language given to setup stays until the person gives another, as the board, its page and stop keep it (#1245).
const chosenWords = {
  en: ['a local board for coding agents', 'Next steps:'],
  'zh-TW': ['給程式 agent 用的本機看板', '接下來：'],
  'zh-CN': ['给编程 agent 用的本机看板', '接下来：'],
}
const assertWords = (result, lang, at) => {
  success(result)
  const others = Object.keys(chosenWords).filter(one => one !== lang)
  assert.ok(result.stdout.includes(chosenWords[lang][at]), `${lang}: ${result.stdout}`)
  for (const other of others) assert.equal(result.stdout.includes(chosenWords[other][at]), false, `${lang} printed ${other}: ${result.stdout}`)
}

test('after setup --lang <lang> --apply, a bare setup, --help and remove print <lang>', () => fixture(f => {
  const pkg = packed(f)
  for (const [lang, LANG] of [['zh-CN', 'zh_TW.UTF-8'], ['en', 'zh_TW.UTF-8'], ['zh-TW', 'en_US.UTF-8']]) {
    const env = { LANG }
    success(f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--lang', lang, '--apply'], env))
    for (const args of [['--help'], ['setup', '--help'], ['remove', '--help']]) assertWords(f.run(pkg, args, env), lang, 0)
    for (const args of [['setup', '--home', f.home], ['remove', '--home', f.home]]) assertWords(f.run(pkg, args, env), lang, 1)
  }
}))

test("a language chosen on the board's page is the one setup, --help and remove use", () => fixture(f => {
  const pkg = packed(f)
  const env = { LANG: 'zh_TW.UTF-8' }
  success(f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--lang', 'en', '--apply'], env))
  const progress = JSON.parse(readFileSync(boardPath(f), 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')).path
  const settings = `${progress.replace(/\.md$/i, '')}-settings.json`
  save(settings, `${JSON.stringify({ lang: 'zh-CN' })}\n`)
  for (const args of [['--help'], ['setup', '--help']]) assertWords(f.run(pkg, args, env), 'zh-CN', 0)
  for (const args of [['setup', '--home', f.home], ['remove', '--home', f.home]]) assertWords(f.run(pkg, args, env), 'zh-CN', 1)
  // Automatic follows the system, as on the page; a --lang on the command still wins.
  save(settings, `${JSON.stringify({ lang: 'auto' })}\n`)
  assertWords(f.run(pkg, ['--help'], env), 'zh-TW', 0)
  assertWords(f.run(pkg, ['setup', '--home', f.home], env), 'zh-TW', 1)
  assertWords(f.run(pkg, ['--help', '--lang', 'en'], env), 'en', 0)
  assertWords(f.run(pkg, ['setup', '--home', f.home, '--lang', 'en'], env), 'en', 1)
}))

test('setup --help and remove --help with --home read the language of that home, not the running account', () => fixture(f => {
  const pkg = packed(f)
  const other = join(f.box, 'other home')
  mkdirSync(other)
  const env = { LANG: 'en_US.UTF-8' }
  success(f.run(pkg, ['setup', '--agent', 'codex', '--home', other, '--lang', 'zh-CN', '--apply'], env))
  assertWords(f.run(pkg, ['--help'], env), 'en', 0)
  for (const args of [['setup', '--home', other, '--help'], ['remove', '--home', other, '--help'], ['setup', '--data-dir', join(other, '.agent-board'), '--help']]) assertWords(f.run(pkg, args, env), 'zh-CN', 0)
  assertWords(f.run(pkg, ['setup', '--home', other], env), 'zh-CN', 1)
}))

test('the language saved for the progress file a command picks is the one help and setup use', () => fixture(f => {
  const pkg = packed(f)
  const env = { LANG: 'en_US.UTF-8' }
  success(f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--lang', 'en', '--apply'], env))
  const progress = JSON.parse(readFileSync(boardPath(f), 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')).path
  save(`${progress.replace(/\.md$/i, '')}-settings.json`, `${JSON.stringify({ lang: 'en' })}\n`)
  const second = join(dirname(progress), 'second.md')
  save(join(dirname(progress), 'second-settings.json'), `${JSON.stringify({ lang: 'zh-CN' })}\n`)
  assertWords(f.run(pkg, ['--help'], env), 'en', 0)
  assertWords(f.run(pkg, ['--help', '--progress-file', second], env), 'zh-CN', 0)
  assertWords(f.run(pkg, ['--help'], { ...env, CLAUDE_PROGRESS_FILE: second }), 'zh-CN', 0)
  assertWords(f.run(pkg, ['setup', '--home', f.home], { ...env, CLAUDE_PROGRESS_FILE: second }), 'zh-CN', 1)
}))

test('a board command with --data-dir reads that board\'s saved language, not CLAUDE_PROGRESS_FILE\'s', () => fixture(f => {
  const pkg = packed(f)
  const env = { LANG: 'en_US.UTF-8' }
  const data = join(f.box, 'other data')
  success(f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--data-dir', data, '--lang', 'en', '--apply'], env))
  const progress = JSON.parse(readFileSync(join(data, 'agent-board.mjs'), 'utf8').split('\n', 1)[0].replace(/^globalThis\.AGENT_BOARD = /, '')).path
  save(`${progress.replace(/\.md$/i, '')}-settings.json`, `${JSON.stringify({ lang: 'en' })}\n`)
  const elsewhere = join(f.box, 'elsewhere', 'progress.md')
  save(join(dirname(elsewhere), 'progress-settings.json'), `${JSON.stringify({ lang: 'zh-CN' })}\n`)
  assertWords(f.run(pkg, ['--help', '--data-dir', data], { ...env, CLAUDE_PROGRESS_FILE: elsewhere }), 'en', 0)
  assertWords(f.run(pkg, ['--help'], { ...env, CLAUDE_PROGRESS_FILE: elsewhere }), 'zh-CN', 0)
}))

test('--lang auto follows the system over a saved language in help and setup', () => fixture(f => {
  const pkg = packed(f)
  const env = { LANG: 'zh_TW.UTF-8' }
  success(f.run(pkg, ['setup', '--agent', 'codex', '--home', f.home, '--lang', 'en', '--apply'], env))
  assertWords(f.run(pkg, ['--help'], env), 'en', 0)
  assertWords(f.run(pkg, ['--help', '--lang', 'auto'], env), 'zh-TW', 0)
  assertWords(f.run(pkg, ['setup', '--home', f.home, '--lang', 'auto'], env), 'zh-TW', 1)
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

test('a later launcher that reuses a server without its address record still refreshes its package version (#1304)', { timeout: 60_000 }, async () => {
  await asyncFixture(async f => {
    const pkg = packed(f)
    save(boardPath(f), `${prelude(f)}${bundle(pkg)}`)
    save(join(f.home, '.agent-board/progress.md'), '# Progress\n')
    // Start the server directly, with no package version: the board says nothing about an update.
    // The runtime folder must exist and be account-only, or the server falls back to ~/.cache.
    const runDir = join(f.tmp, 'run')
    mkdirSync(runDir, { mode: 0o700 })
    const child = spawn(process.execPath, [boardPath(f), '--serve-child'], {
      cwd: f.box, env: { ...f.env, AGENT_BOARD_PACKAGE_VERSION: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = new Promise(done => child.once('exit', code => done(code)))
    const firstUrl = await new Promise((done, fail) => {
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        out += chunk
        if (out.includes('\n')) done(new URL(out.split('\n')[0].trim()))
      })
      exited.then(code => fail(new Error(`the server exited with ${code}: ${stderr}`)))
    })
    const token = firstUrl.searchParams.get('t')
    const board = async () => {
      const response = await fetch(new URL('/api/board', firstUrl), { headers: { 'x-board-token': token, 'x-board-page': 'p-test', 'x-board-visible': '1' } })
      return JSON.parse(await response.text()).model
    }
    try {
      assert.equal((await board()).view.versions.package, null)
      assert.equal((await board()).health, undefined)
      // The address record is gone, so the next launcher run reaches the server through its
      // owner record, not the file: it must still tell the server its package version.
      // On Windows the record lives in the account-only `agent-board` child of the runtime
      // folder; elsewhere it is in the runtime folder itself (board-cli.ts runFolder).
      const recordDirs = [runDir, join(runDir, 'agent-board')]
      const records = recordDirs.flatMap(dir => {
        try { return readdirSync(dir).filter(name => name.startsWith('agent-board-') && name.endsWith('.json')).map(name => join(dir, name)) } catch { return [] }
      })
      assert.equal(records.length, 1, JSON.stringify(records))
      unlinkSync(records[0])
      // CI keeps a text read for scripts (hooks/surface.ts pickSurface), so under CI the plain
      // call prints the text board and no address. This test is about the reuse, not the
      // surface: run the launcher as a non-CI call so it opens the page and prints its address.
      const second = f.run(pkg, [], { CI: '0' })
      success(second)
      const { link } = readPrintedLink(second, { wordings: [EN.boardPageAlreadyOpenLink] })
      assert.equal(second.stdout.trim(), EN.boardPageAlreadyOpenLink(link))
      const after = await board()
      assert.equal(after.view.versions.package, manifest.version)
      // The package is the board's own version, so there is no update to name.
      assert.equal(after.health, undefined)
    } finally {
      await fetch(new URL('/api/close', firstUrl), { method: 'POST', headers: { 'x-board-token': token, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined)
      await Promise.race([exited, new Promise(done => setTimeout(done, 5000))])
      if (child.exitCode === null) child.kill()
    }
  })
})

test('a later launcher that reuses a server through the retry wait or the claim backoff still refreshes its package version (#1304)', { timeout: 120_000 }, async () => {
  await asyncFixture(async f => {
    const pkg = packed(f)
    save(boardPath(f), `${prelude(f)}${bundle(pkg)}`)
    const progressPath = join(f.home, '.agent-board/progress.md')
    save(progressPath, '# Progress\n')
    // The runtime folder must exist and be account-only, or the server falls back to ~/.cache.
    const runDir = join(f.tmp, 'run')
    mkdirSync(runDir, { mode: 0o700 })
    // The address file the launcher reads for this board, and the messages folder beside it.
    // On Windows the record lives in the account-only `agent-board` child of the runtime
    // folder; elsewhere it is in the runtime folder itself (board-cli.ts runFolder).
    const recordDir = process.platform === 'win32' ? join(runDir, 'agent-board') : runDir
    mkdirSync(recordDir, { mode: 0o700, recursive: true })
    // On Windows the launcher reads the address file only when its access list names this
    // account alone: a plain file under an inherited %TEMP% list is refused, and the wait loop
    // never finds the page. The record is written the way a real server writes it.
    if (process.platform === 'win32') privateRuntimeFolder(recordDir)
    const recordName = `agent-board-${createHash('sha256').update(resolve(progressPath)).digest('hex').slice(0, 16)}.json`
    const recordPath = join(recordDir, recordName)
    const messagesDir = recordPath.replace(/\.json$/, '-messages')
    mkdirSync(messagesDir, { mode: 0o700, recursive: true })
    const rawScript = readFileSync(boardPath(f), 'utf8')
    const cut = rawScript.indexOf('\n')
    const built = createHash('sha256').update((rawScript.startsWith('globalThis.AGENT_BOARD = ') ? (cut >= 0 ? rawScript.slice(cut + 1) : '') : rawScript).replace(/\r\n/g, '\n')).digest('hex')
    // The message store is held by this test process: the launcher's child cannot claim it
    // and fails with MESSAGE_STORE_IN_USE, so onePass takes the retry path. No lock file, so
    // the owner block is skipped and the two retry returns are the only way back.
    const nonce = randomBytes(16).toString('hex')
    const claimName = `.message-claim-${process.pid}-${nonce}.json`
    writeFileSync(join(messagesDir, claimName), `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`, { mode: 0o600 })
    // A stand-in for another launch's page: it answers the launcher's probe and records the
    // package version the launcher tells it. A hanging /api/ping stands in for a page still
    // starting, so the launcher's wait loop cannot find it until the test lets it answer.
    const posts = []
    let openCount = 0
    let answerPing = true
    const sockets = new Set()
    const fake = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        if (!answerPing) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: resolve(progressPath), built, allowResume: false, codexSend: true, messagesDirectory: resolve(messagesDir) }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/open-link') {
        if (req.headers['x-board-token'] !== 'retrytesttoken') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ url: `http://127.0.0.1:${fake.address().port}/open/synthetic-open-${String(++openCount).padStart(4, '0')}` }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/package') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try { posts.push(JSON.parse(body)) } catch { posts.push(null) }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/close') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })
    fake.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise(done => fake.listen(0, '127.0.0.1', done))
    const port = fake.address().port
    const fakeUrl = `http://127.0.0.1:${port}/?t=retrytesttoken`
    const writeRecord = () => {
      const text = JSON.stringify({ pid: 2147483647, port, url: fakeUrl, path: resolve(progressPath), built })
      if (process.platform === 'win32') writePrivateRuntimeFile(recordPath, text)
      else writeFileSync(recordPath, text, { mode: 0o600 })
    }
    const sleep = ms => new Promise(done => setTimeout(done, ms))
    const waitFor = async (check, timeoutMs, what) => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        if (check()) return
        await sleep(5)
      }
      throw new Error(`timed out waiting for ${what}`)
    }
    // The child's claim appears and is released within milliseconds, so the signal is the
    // messages folder changing, not the file itself. It also proves ensureServer's first
    // lookup already ran, since the child starts only after it.
    let baselineMtime = statSync(messagesDir).mtimeMs
    const childClaimed = () => {
      try {
        if (statSync(messagesDir).mtimeMs !== baselineMtime) return true
        return readdirSync(messagesDir).some(name => name.startsWith('.message-claim-') && name !== claimName)
      } catch { return false }
    }
    // How many pages the launcher started: a retry after the backoff would start a second
    // child, and a return from that retry's wait would prove the wrong return, so more than
    // one claim per scenario fails the test. The watcher may miss a claim, so zero is allowed.
    let claimCreates = 0
    let watcher = null
    try {
      watcher = watch(messagesDir, (event, filename) => {
        if (event !== 'rename' || typeof filename !== 'string' || !filename.startsWith('.message-claim-') || filename === claimName) return
        try { if (existsSync(join(messagesDir, filename))) claimCreates++ } catch {}
      })
    } catch {}
    // The launcher, run in the background so this test can publish the address while it waits.
    let launcher = null
    const runLauncher = () => new Promise((resolvePromise, rejectPromise) => {
      launcher = spawn(process.execPath, [join(pkg, 'bin/agent-board.mjs')], { cwd: f.box, env: { ...f.env, CI: '0' }, windowsHide: true })
      let stdout = ''
      let stderr = ''
      launcher.stdout.setEncoding('utf8')
      launcher.stdout.on('data', chunk => { stdout += chunk })
      launcher.stderr.setEncoding('utf8')
      launcher.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => {
        launcher.kill()
        rejectPromise(new Error(`the launcher did not exit in time: ${stderr}`))
      }, 25000)
      launcher.once('error', error => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      launcher.once('close', code => {
        clearTimeout(timer)
        resolvePromise({ code, stdout, stderr })
      })
    })
    try {
      // The wait loop: the page answers from the start, so the loop's poll finds it.
      answerPing = true
      baselineMtime = statSync(messagesDir).mtimeMs
      let before = claimCreates
      let run = runLauncher()
      await waitFor(childClaimed, 15000, 'the launcher child to claim the message store')
      writeRecord()
      const waited = await run
      assert.equal(waited.code, 0, waited.stderr)
      readPrintedLink(waited, { wordings: [EN.boardPageLink], secrets: ['retrytesttoken'] })
      assert.equal(posts.length, 1, JSON.stringify(posts))
      assert.equal(posts[0]?.version, manifest.version)
      assert.ok(claimCreates - before <= 1, `the launcher started ${claimCreates - before} children in the wait scenario`)
      // The record stays after a reuse, so the next launch must not find it in its first lookup.
      unlinkSync(recordPath)
      posts.length = 0
      // The claim-collision backoff: the page hangs while the wait loop runs, so the loop
      // cannot find it and its poll deletes the record; the backoff then finds the address
      // the test publishes after that deletion. The record is published half a second after
      // the child's claim, so the hanging poll starts well before the loop's two-second wait
      // ends and deletes the record well after it: the deletion marks the loop's end, and a
      // loop poll can never see the page answering.
      answerPing = false
      baselineMtime = statSync(messagesDir).mtimeMs
      before = claimCreates
      run = runLauncher()
      await waitFor(childClaimed, 15000, 'the launcher child to claim the message store')
      await sleep(500)
      writeRecord()
      await waitFor(() => !existsSync(recordPath), 15000, 'the wait loop to delete the address record')
      answerPing = true
      writeRecord()
      const backedOff = await run
      assert.equal(backedOff.code, 0, backedOff.stderr)
      readPrintedLink(backedOff, { wordings: [EN.boardPageLink], secrets: ['retrytesttoken'] })
      assert.equal(posts.length, 1, JSON.stringify(posts))
      assert.equal(posts[0]?.version, manifest.version)
      assert.ok(claimCreates - before <= 1, `the launcher started ${claimCreates - before} children in the backoff scenario`)
    } finally {
      if (launcher !== null && launcher.exitCode === null) launcher.kill()
      watcher?.close()
      for (const socket of sockets) socket.destroy()
      await new Promise(done => fake.close(done))
    }
  })
})

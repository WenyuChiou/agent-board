import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bundleFiles, bundleFromDir } from '../scripts/bundle-text.mjs'
import { privateRuntimeFolder, writePrivateRuntimeFile } from '../scripts/runtime-folder.ts'
import { setupPrograms } from './helpers/setup-programs.mjs'

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

// #1314: a person who opens the board in a terminal through an older setup-installed script gets the update itself,
// with setup's one question, in the install root the script names; no command to copy.
test('the launcher finds an older installed script and starts setup --update with its roots', () => fixture(f => {
  const pkg = packed(f)
  const root = join(f.home, 'data dir')
  success(f.run(pkg, ['setup', '--agent', 'opencode', '--data-dir', root, '--apply']))
  const script = join(root, 'agent-board.mjs'), record = join(root, 'install-opencode.json')
  const text = `${readFileSync(script, 'utf8')}\n// older\n`
  save(script, text)
  // An earlier release wrote that script and recorded it as setup's own, before the release that added the new uses.
  const owned = JSON.parse(readFileSync(record, 'utf8'))
  for (const file of Object.keys(owned.files)) if (resolve(file) === resolve(script)) owned.files[file] = createHash('sha256').update(text).digest('hex')
  delete owned.version
  save(record, `${JSON.stringify(owned, null, 2)}\n`)
  save(join(pkg, 'hooks/released.ts'), `export const RELEASED = [{ version: '0.0.1', board: ['${bodyHash(text)}'] }]\n`)
  const result = f.run(pkg, ['--data-dir', root, '--print'], terminalLauncher(f), 'y\n')
  success(result)
  assert.equal(result.stdout.split('[y/N]').length - 1, 1, result.stdout)
  for (const words of ['"Check for new versions"', 'the list of your Codex sessions']) assert.ok(result.stdout.includes(words), result.stdout)
  assert.equal(bodyHash(readFileSync(script, 'utf8')), bodyHash(`\n${bundle(pkg)}`), "the update wrote this package's board script")
  assert.equal(typeof JSON.parse(readFileSync(record, 'utf8')).version, 'string', 'the record names the version')
  assert.ok(result.stdout.split('Agent Board updated to')[1]?.split('\n').slice(1).join('\n').trim(), `the board opened after the update\n${result.stdout}`)
  assert.equal(result.stderr.includes('To update it, preview'), false, result.stderr)
  // The install lock always sits in ~/.agent-board; no file of the install goes there.
  assert.deepEqual(existsSync(join(f.home, '.agent-board')) ? filesUnder(join(f.home, '.agent-board')) : [], [], 'the update stayed in the install root')
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
      const found = second.stdout.match(/https?:\/\/\S+/)
      assert.ok(found, `the launcher printed no address: ${second.stdout}`)
      const secondUrl = new URL(found[0])
      assert.equal(secondUrl.href, firstUrl.href)
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
    const built = String(statSync(boardPath(f)).mtimeMs)
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
      assert.ok(waited.stdout.includes(fakeUrl), waited.stdout)
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
      assert.ok(backedOff.stdout.includes(fakeUrl), backedOff.stdout)
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

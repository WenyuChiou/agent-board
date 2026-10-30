import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

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
  }
  const run = (pkg, args = [], extraEnv = {}) => spawnSync(process.execPath, [join(pkg, 'bin/agent-board.mjs'), ...args], {
    cwd: box, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  try { return fn({ box, home, tmp, env, run }) }
  finally { rmSync(box, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) }
}
const success = result => {
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
}
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
const bundle = pkg => {
  const source = readFileSync(join(pkg, 'hooks/board-script.ts'), 'utf8')
  const marker = 'export const BOARD_SCRIPT = '
  return JSON.parse(source.slice(source.indexOf(marker) + marker.length))
}
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
    assert.ok(result.stdout.includes('--serve'))
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
  assert.equal(result.stderr, 'agent-board: unknown command "serve". The board takes options such as --serve; run agent-board --help.\n')
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
  for (const [lang, hint] of [['en', 'setup found no agent'], ['zh-TW', 'setup 在這台電腦找不到要設定的 agent'], ['zh-CN', 'setup 在这台电脑找不到要设置的 agent']]) {
    for (const extra of [[], ['--agent', 'unknown']]) {
      const result = f.run(pkg, ['setup', '--home', f.home, '--lang', lang, ...extra])
      assert.ifError(result.error)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(result.stderr.includes(hint), result.stderr)
      assert.ok(result.stderr.includes(`npx ${manifest.name} setup --agent codex`), result.stderr)
      assert.equal(result.stderr.includes('    at '), false)
      assert.equal(result.stderr.includes(pkg), false)
      assert.equal(result.stderr.trim().split('\n').length, 1)
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
    assert.equal(setup.status, 1)
    assert.ok(setup.stderr.includes(`npx ${renamed.name} setup --agent codex`))
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

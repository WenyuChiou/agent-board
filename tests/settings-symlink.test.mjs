import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs, { chmodSync, existsSync, lstatSync, lutimesSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { EN } from '../hooks/strings-en.ts'
import { ZH_TW } from '../hooks/i18n.ts'
import { ZH_CN } from '../hooks/strings-zh-cn.ts'
import { SETTINGS_CHANGED, SETTINGS_LOCKED, SETTINGS_READ, SETTINGS_UNSAFE, SETTINGS_WRITE } from '../hooks/settings-script.ts'
import { readSettings, replaceSettings, updateSettings } from '../scripts/settings-file.ts'

// The plugin's write script: the file and the kind on its command line, the two texts as JSON on stdin (never in the arguments).
const writeScript = (file, next, kind, base, node = []) => spawnSync(process.execPath, [...node, '-e', SETTINGS_WRITE, '--', file, kind], { input: JSON.stringify({ next, base: kind === 'ok' ? base : null }), timeout: 5000, encoding: 'utf8' })

const post = (port, token, path, body) => new Promise((resolve, reject) => {
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path,
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-board-token': token },
  }, res => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { data += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }))
  })
  req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')))
  req.on('error', reject)
  req.end(JSON.stringify(body))
})

const serve = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-symlink-'))
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const path = join(dir, 'progress.md')
  writeFileSync(path, '# Progress\n\n## Demo\n- [ ] Task\n')
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
  const child = spawn(process.execPath, [script, '--serve-child'], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROGRESS_FILE: '', HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, APPDATA: dir, LOCALAPPDATA: dir, NO_COLOR: '1', XDG_RUNTIME_DIR: run, LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(done => child.once('exit', code => done(code)))
  const url = await new Promise((done, fail) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      out += chunk
      if (out.includes('\n')) done(new URL(out.split('\n')[0].trim()))
    })
    exited.then(code => fail(new Error(`server exited with ${code}: ${stderr}`)))
  })
  const port = Number(url.port)
  const token = url.searchParams.get('t')
  return {
    dir,
    path,
    port,
    token,
    call: (method, route, options = {}) => post(port, token, route, options.body ?? {}),
    close: async () => {
      child.kill()
      await Promise.race([exited, delay(1000)])
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// A skipped test says why. A silent pass hid the link assertions on a computer that cannot make links (#1276).
const canLink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-probe-'))
  try {
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
const noLinks = canLink ? false : 'this computer cannot make symbolic links, so the link cases did not run'
const canFifo = (() => {
  if (process.platform === 'win32') return false
  const dir = mkdtempSync(join(tmpdir(), 'settings-probe-'))
  try {
    execFileSync('mkfifo', [join(dir, 'f')])
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
const noFifo = canFifo ? false : 'this computer cannot make a FIFO, so the FIFO case did not run'

// Each link target holds valid JSON, which the code before #1264 wrote through, or is missing, which it created.
for (const [route, label, body, name] of [
  ['/api/style', 'saveBarStyle', { style: 'blue' }, 'victim-style'],
  ['/api/language', 'saveLanguage', { lang: 'zh-TW' }, 'victim-lang'],
]) {
  test(`${label} refuses a link to a valid JSON file and leaves the target alone (#1261, #1276)`, { skip: noLinks }, async () => {
    const board = await serve()
    try {
      const settings = join(board.dir, 'progress-settings.json')
      const victim = join(board.dir, `${name}.json`)
      writeFileSync(victim, '{"keep":"sensitive target content"}\n')
      symlinkSync(victim, settings)
      const res = await board.call('POST', route, { body })
      assert.equal(res.status, 409)
      assert.equal(res.json().note, EN.barStyleUnsafe)
      assert.equal(readFileSync(victim, 'utf8'), '{"keep":"sensitive target content"}\n')
      assert.ok(lstatSync(settings).isSymbolicLink(), 'the link is still a link')
    } finally {
      await board.close()
    }
  })

  test(`${label} refuses a link to a missing file and does not create the target (#1261, #1276)`, { skip: noLinks }, async () => {
    const board = await serve()
    try {
      const settings = join(board.dir, 'progress-settings.json')
      const victim = join(board.dir, `${name}-missing.json`)
      symlinkSync(victim, settings)
      const res = await board.call('POST', route, { body })
      assert.equal(res.status, 409)
      assert.equal(res.json().note, EN.barStyleUnsafe)
      assert.equal(existsSync(victim), false)
    } finally {
      await board.close()
    }
  })

  test(`${label} refuses a folder at the settings path and says it is not a plain file (#1261, #1276)`, async () => {
    const board = await serve()
    try {
      const settings = join(board.dir, 'progress-settings.json')
      mkdirSync(settings)
      const res = await board.call('POST', route, { body })
      assert.equal(res.status, 409)
      assert.equal(res.json().note, EN.barStyleUnsafe)
      assert.deepEqual(readdirSync(settings), [])
      rmdirSync(settings)
    } finally {
      await board.close()
    }
  })
}

test('a settings file with invalid JSON still says it is not valid JSON (#1261)', async () => {
  const board = await serve()
  try {
    const settings = join(board.dir, 'progress-settings.json')
    writeFileSync(settings, 'not json')
    const res = await board.call('POST', '/api/style', { body: { style: 'blue' } })
    assert.equal(res.status, 409)
    assert.equal(res.json().note, EN.barStyleUnreadable)
    assert.equal(readFileSync(settings, 'utf8'), 'not json')
  } finally {
    await board.close()
  }
})

test('a link swapped in after the check is refused, never written through (#1276)', { skip: noLinks }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-swap-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const victim = join(dir, 'victim.json')
    writeFileSync(settings, '{"old":true}\n')
    writeFileSync(victim, '{"keep":true}\n')
    // The path is a regular file when checked; the swap happens after the new file is written.
    const done = replaceSettings(settings, '{"old":true}\n', '{"style":"blue"}\n', () => { unlinkSync(settings); symlinkSync(victim, settings) })
    assert.equal(done, 'unsafe')
    assert.equal(readFileSync(victim, 'utf8'), '{"keep":true}\n')
    assert.equal(lstatSync(settings).isSymbolicLink(), true)
    assert.deepEqual(readdirSync(dir).sort(), ['progress-settings.json', 'victim.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Two saves in a row (#1276, Greptile): the second read the file before the first wrote, and its write put
// the old text back over the first. The write now checks the file still holds what the change was worked out
// from, and the change is worked out again from the fresh text.
test('a save made between the read and the write is kept, not undone (#1276)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-two-writers-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    writeFileSync(settings, '{"lang":"en"}\n')
    const other = () => writeFileSync(settings, '{"lang":"zh-TW"}\n')
    // The write alone: the file changed under it, so nothing is written over it.
    assert.equal(replaceSettings(settings, '{"lang":"en"}\n', '{"lang":"en","style":"blue"}\n', other), 'changed')
    assert.equal(readFileSync(settings, 'utf8'), '{"lang":"zh-TW"}\n')
    // The whole save: worked out again from the fresh text, so both picks are in the file.
    writeFileSync(settings, '{"lang":"en"}\n')
    const saved = updateSettings(settings, text => JSON.stringify({ ...JSON.parse(text ?? '{}'), style: 'blue' }) + '\n', other)
    assert.equal(saved.result, 'ok')
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { lang: 'zh-TW', style: 'blue' })
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin write refuses when the file no longer holds the text it was worked out from (#1276)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-script-two-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const write = (next, kind, base) => writeScript(settings, next, kind, base).status
    // Another save landed after the plugin read '{"lang":"en"}'.
    writeFileSync(settings, '{"lang":"zh-TW"}\n')
    assert.equal(write('{"lang":"en","style":"blue"}\n', 'ok', '{"lang":"en"}\n'), SETTINGS_CHANGED)
    assert.equal(readFileSync(settings, 'utf8'), '{"lang":"zh-TW"}\n')
    // It read no file, and one has appeared since.
    assert.equal(write('{"style":"blue"}\n', 'missing', ''), SETTINGS_CHANGED)
    assert.equal(readFileSync(settings, 'utf8'), '{"lang":"zh-TW"}\n')
    // The text it read is still there: written.
    assert.equal(write('{"lang":"zh-TW","style":"blue"}\n', 'ok', '{"lang":"zh-TW"}\n'), 0)
    assert.equal(readFileSync(settings, 'utf8'), '{"lang":"zh-TW","style":"blue"}\n')
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A rename puts a new file at the path, and the new file got the process's default mode: under a umask of 022 a
// file kept private (0600) became readable by everyone (#1276, Greptile). Both writers copy the old file's bits.
test('both writers keep the settings file private: 0600 stays 0600 under a umask of 022, and a new file is 0600 (#1276)', { skip: process.platform === 'win32' && 'Windows has no POSIX permission bits' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-mode-'))
  const before = process.umask(0o022)
  try {
    const settings = join(dir, 'progress-settings.json')
    const modeOf = () => (statSync(settings).mode & 0o777).toString(8)
    const script = (next, kind, base) => writeScript(settings, next, kind, base).status
    writeFileSync(settings, '{"a":1}\n')
    chmodSync(settings, 0o600)
    assert.equal(replaceSettings(settings, '{"a":1}\n', '{"a":2}\n'), 'ok')
    assert.equal(modeOf(), '600', 'replaceSettings keeps 0600')
    assert.equal(script('{"a":3}\n', 'ok', '{"a":2}\n'), 0)
    assert.equal(modeOf(), '600', 'the plugin write keeps 0600')
    chmodSync(settings, 0o640)
    assert.equal(replaceSettings(settings, '{"a":3}\n', '{"a":4}\n'), 'ok')
    assert.equal(modeOf(), '640', 'another mode is kept as it was')
    unlinkSync(settings)
    assert.equal(replaceSettings(settings, null, '{"b":1}\n'), 'ok')
    assert.equal(modeOf(), '600', 'replaceSettings makes a new file 0600')
    unlinkSync(settings)
    assert.equal(script('{"b":2}\n', 'missing', ''), 0)
    assert.equal(modeOf(), '600', 'the plugin write makes a new file 0600')
  } finally {
    process.umask(before)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read of the settings file does not wait on a FIFO with no writer (#1276)', { skip: noFifo }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-fifo-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    execFileSync('mkfifo', [settings])
    assert.deepEqual(readSettings(settings), { kind: 'unsafe' })
    // The scripts the plugin runs must come back as well.
    const ran = spawnSync(process.execPath, ['-e', SETTINGS_READ, '--', settings], { timeout: 5000, encoding: 'utf8' })
    assert.equal(ran.error, undefined)
    assert.equal(ran.status, 0)
    assert.deepEqual(JSON.parse(ran.stdout), { kind: 'unsafe' })
    const wrote = writeScript(settings, '{}', 'missing', '')
    assert.equal(wrote.error, undefined)
    assert.equal(wrote.status, SETTINGS_UNSAFE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The plugin write reads the file back after the rename. That read blocked on a FIFO put at the path right after the
// rename, so `/progress style` hung until its timeout (#1276, Greptile on 968bfcc4). A preload swaps the path there.
test('the plugin write does not wait on a FIFO put at the path right after its rename (#1276)', { skip: noFifo }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-fifo-after-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const swap = join(dir, 'swap.cjs')
    writeFileSync(swap, `const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const rename = fs.renameSync
fs.renameSync = (from, to) => { rename(from, to); fs.unlinkSync(to); execFileSync('mkfifo', [to]) }
`)
    const wrote = writeScript(settings, '{"style":"blue"}\n', 'missing', '', ['--require', swap])
    assert.equal(wrote.error, undefined, 'the write came back')
    assert.equal(wrote.status, SETTINGS_UNSAFE)
    assert.ok(!lstatSync(settings).isFile(), 'the FIFO the preload put there is still there')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The startup language read and the terminal board's style read both come before any guarded save. A FIFO with no
// writer blocked them for good on Linux and macOS (#1276); the board must still start and print.
test('the board starts and prints with a FIFO at the settings path (#1276)', { skip: noFifo }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-fifo-board-'))
  try {
    const path = join(dir, 'progress.md')
    writeFileSync(path, '# Progress\n\n## Demo\n- [ ] Task\n')
    execFileSync('mkfifo', [join(dir, 'progress-settings.json')])
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', HOME: dir, USERPROFILE: dir, NO_COLOR: '1', LANG: 'en' }
    for (const mode of ['--status', '--print']) {
      const ran = spawnSync(process.execPath, [script, mode], { cwd: dir, env, timeout: 8000, encoding: 'utf8' })
      assert.equal(ran.error, undefined, `${mode} came back`)
      assert.equal(ran.status, 0, `${mode} exit`)
      assert.ok(ran.stdout.length > 0, `${mode} printed`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin scripts read a plain file, report a missing one, and refuse a link or a folder (#1276)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-script-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const read = () => JSON.parse(spawnSync(process.execPath, ['-e', SETTINGS_READ, '--', settings], { timeout: 5000, encoding: 'utf8' }).stdout)
    const write = (text, kind = 'missing', base = '') => writeScript(settings, text, kind, base).status
    assert.deepEqual(read(), { kind: 'missing' })
    assert.equal(write('{"style":"green"}\n'), 0)
    assert.deepEqual(read(), { kind: 'ok', text: '{"style":"green"}\n' })
    unlinkSync(settings)
    mkdirSync(settings)
    assert.deepEqual(read(), { kind: 'unsafe' })
    assert.equal(write('{}'), SETTINGS_UNSAFE)
    rmdirSync(settings)
    if (canLink) {
      const victim = join(dir, 'victim.json')
      writeFileSync(victim, '{"keep":true}\n')
      symlinkSync(victim, settings)
      assert.deepEqual(read(), { kind: 'unsafe' })
      assert.equal(write('{"style":"blue"}'), SETTINGS_UNSAFE)
      assert.equal(readFileSync(victim, 'utf8'), '{"keep":true}\n')
    }
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Codex P1 on #1339: when the exclusive create of the temp name met a file already there (EEXIST), the cleanup
// deleted that file. Only a temp this write created is deleted.
test('a temp name that is already taken is left alone by both writers, and the write fails (#1276)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-taken-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const name = pid => `${settings}.${pid}.${(1000).toString(36)}.tmp`
    // The in-process writer: this process's id and a fixed clock make the temp name known.
    const realNow = Date.now
    Date.now = () => 1000
    try {
      writeFileSync(name(process.pid), 'SOMEBODY ELSE\n')
      assert.throws(() => replaceSettings(settings, null, '{"style":"blue"}\n'), error => error.code === 'EEXIST')
    } finally { Date.now = realNow }
    assert.equal(readFileSync(name(process.pid), 'utf8'), 'SOMEBODY ELSE\n')
    assert.equal(existsSync(settings), false)
    unlinkSync(name(process.pid))
    // The plugin's script, run with a fixed pid and clock for the same reason.
    const preload = join(dir, 'fixed.cjs')
    writeFileSync(preload, "Date.now = () => 1000; Object.defineProperty(process, 'pid', { value: 4242 })\n")
    writeFileSync(name(4242), 'SOMEBODY ELSE\n')
    const wrote = writeScript(settings, '{"style":"blue"}\n', 'missing', '', ['--require', preload])
    assert.equal(wrote.status, 1)
    assert.equal(readFileSync(name(4242), 'utf8'), 'SOMEBODY ELSE\n')
    assert.equal(existsSync(settings), false)
    // With the name free, the same script writes and leaves no temp file behind.
    unlinkSync(name(4242))
    assert.equal(writeScript(settings, '{"style":"blue"}\n', 'missing', '', ['--require', preload]).status, 0)
    assert.equal(readFileSync(settings, 'utf8'), '{"style":"blue"}\n')
    assert.deepEqual(readdirSync(dir).filter(file => file.endsWith('.tmp')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin write takes its two texts from stdin and refuses input it cannot read (#1276)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-stdin-'))
  try {
    const settings = join(dir, 'progress-settings.json')
    const run = input => spawnSync(process.execPath, ['-e', SETTINGS_WRITE, '--', settings, 'missing'], { input, timeout: 5000, encoding: 'utf8' })
    assert.equal(run('').status, 1)
    assert.equal(run('not json').status, 1)
    assert.equal(run(JSON.stringify({ base: null })).status, 1)
    assert.equal(existsSync(settings), false)
    assert.equal(run(JSON.stringify({ next: '{"lang":"en"}\n', base: null })).status, 0)
    assert.equal(readFileSync(settings, 'utf8'), '{"lang":"en"}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Codex 102 P1 on #1339: a save by our other writer between the last re-read and the rename was overwritten while both
// reported success. Both writers now take `<file>.agent-board.lock`; these two tests hold the first writer just before its
// rename (a patched renameSync / a preloaded one) while the second writer runs, which loses a key without the lock.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const settingsModule = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'settings-file.ts')).href
// A second CLI writer in its own process: adds one key through updateSettings, and says it started by touching `ready`.
const cliWriterScript = dir => {
  const script = join(dir, 'cli-writer.mjs')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'
import { updateSettings } from ${JSON.stringify(settingsModule)}
const [file, key, ready] = process.argv.slice(2)
writeFileSync(ready, 'x')
const done = updateSettings(file, text => JSON.stringify({ ...JSON.parse(text ?? '{}'), [key]: true }))
process.exitCode = done.result === 'ok' ? 0 : 3
`)
  return script
}
const waitFor = async (path, ms = 8000) => {
  const end = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} never appeared`)
    await delay(10)
  }
}

test('two CLI writers saving at the same time each keep their key (the lock covers re-read to read-back)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-lock-cli-'))
  const file = join(dir, 'progress-settings.json')
  const ready = join(dir, 'ready')
  writeFileSync(file, '{"a":true}')
  const real = fs.renameSync
  let child
  let exited
  fs.renameSync = (from, to) => {
    if (child === undefined) {
      child = spawn(process.execPath, [cliWriterScript(dir), file, 'b', ready], { stdio: 'ignore' })
      exited = new Promise(done => child.once('exit', code => done(code)))
      const end = Date.now() + 8000
      while (!existsSync(ready) && Date.now() < end) sleepSync(10)
      sleepSync(800)
    }
    return real(from, to)
  }
  syncBuiltinESMExports()
  try {
    const mine = updateSettings(file, text => JSON.stringify({ ...JSON.parse(text ?? '{}'), c: true }))
    assert.equal(mine.result, 'ok')
  } finally {
    fs.renameSync = real
    syncBuiltinESMExports()
  }
  try {
    assert.equal(await exited, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: true, b: true, c: true })
    assert.equal(existsSync(`${file}.agent-board.lock`), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the plugin script and a CLI writer saving at the same time each keep their key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-lock-plugin-'))
  const file = join(dir, 'progress-settings.json')
  const atRename = join(dir, 'at-rename')
  const preload = join(dir, 'hold-rename.cjs')
  writeFileSync(preload, `const fs = require('node:fs')
const real = fs.renameSync
fs.renameSync = (from, to) => {
  fs.writeFileSync(${JSON.stringify(atRename)}, 'x')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
  return real(from, to)
}
`)
  writeFileSync(file, '{"a":true}')
  const plugin = spawn(process.execPath, ['-r', preload, '-e', SETTINGS_WRITE, '--', file, 'ok'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const pluginExit = new Promise(done => plugin.once('exit', code => done(code)))
  plugin.stdin.end(JSON.stringify({ next: '{"a":true,"p":true}', base: '{"a":true}' }))
  try {
    await waitFor(atRename)
    const cli = spawnSync(process.execPath, [cliWriterScript(dir), file, 'c', join(dir, 'ready')], { timeout: 15000, encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(await pluginExit, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: true, p: true, c: true })
    assert.equal(existsSync(`${file}.agent-board.lock`), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Every lock case runs in a child: a synchronous FIFO read must not hang the test process.
const lockBase = '{"lang":"en"}\n'
const lockNext = '{"lang":"zh-TW"}\n'
const cliLockScript = body => `import fs from 'node:fs'
import { replaceSettings, withSettingsLock } from ${JSON.stringify(settingsModule)}
const file = process.argv[1], lockPath = file + '.agent-board.lock'
try { ${body} } catch (error) { console.error(error.message); process.exitCode = 1 }
`
const runLockChild = (writer, file, { callback, preload, onWaiting } = {}) => new Promise((resolve, reject) => {
  const body = callback === undefined
    ? `if (replaceSettings(file, ${JSON.stringify(lockBase)}, ${JSON.stringify(lockNext)}) !== 'ok') throw new Error('save failed')`
    : `withSettingsLock(file, () => { ${callback} })`
  const plugin = callback === undefined ? SETTINGS_WRITE : SETTINGS_WRITE.replace('withSettingsLock(finish)', `withSettingsLock(() => { ${callback} })`)
  const source = writer === 'plugin' ? plugin : cliLockScript(body)
  const args = [...(preload ? ['--require', preload] : []), ...(writer === 'cli' ? ['--input-type=module'] : []), '-e', source, '--', file, 'ok']
  const started = performance.now()
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = '', timedOut = false, waiting = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (!waiting && stdout.includes('WAITING\n')) { waiting = true; onWaiting?.() }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', status => {
    clearTimeout(timer)
    resolve({ status, stdout, stderr, timedOut, waiting, elapsed: performance.now() - started })
  })
  child.stdin.end(JSON.stringify({ next: lockNext, base: lockBase }))
})

const lockSnapshot = file => {
  const info = lstatSync(file, { bigint: true })
  return {
    dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs,
    content: info.isFile() ? readFileSync(file) : info.isSymbolicLink() ? readlinkSync(file) : info.isDirectory() ? readdirSync(file) : null,
  }
}
const oldLock = (dir, shape) => {
  const file = join(dir, 'progress-settings.json')
  const lock = `${file}.agent-board.lock`
  const target = join(dir, 'lock-target')
  writeFileSync(file, lockBase)
  if (shape === 'folder') mkdirSync(lock)
  else if (shape === 'FIFO') execFileSync('mkfifo', [lock])
  else if (shape === 'dangling link' || shape === 'link to a FIFO' || shape === 'link to a regular file') {
    if (shape === 'link to a FIFO') execFileSync('mkfifo', [target])
    if (shape === 'link to a regular file') writeFileSync(target, 'synthetic target\n')
    symlinkSync(target, lock, 'file')
  } else {
    const content = shape === 'dead pid' ? '999999 0\n' : shape === 'live pid' ? `${process.pid} 0\n` : shape === 'garbage' ? 'synthetic garbage\n' : ''
    writeFileSync(lock, content)
  }
  const old = new Date(Date.now() - 60_000)
  if (lstatSync(lock).isSymbolicLink()) {
    lutimesSync(lock, old, old)
    if (shape !== 'dangling link') utimesSync(target, old, old)
  } else utimesSync(lock, old, old)
  return { file, lock, target }
}

for (const writer of ['cli', 'plugin']) {
  for (const [shape, skip] of [
    ['dead pid', false], ['live pid', false], ['empty', false], ['garbage', false],
    ['FIFO', noFifo], ['folder', false], ['dangling link', noLinks],
    ['link to a FIFO', noFifo || noLinks], ['link to a regular file', noLinks],
  ]) {
    test(`${writer} leaves a 60-second-old ${shape} lock untouched and reports its path`, { skip }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'settings-lock-shape-'))
      try {
        const { file, lock, target } = oldLock(dir, shape)
        const before = lockSnapshot(lock)
        const targetBefore = existsSync(target) ? lockSnapshot(target) : null
        const ran = await runLockChild(writer, file)
        assert.equal(ran.timedOut, false, ran.stderr)
        assert.ok(ran.elapsed < 3000, `save took ${ran.elapsed} ms`)
        assert.notEqual(ran.status, 0)
        if (!(process.platform === 'win32' && shape === 'folder')) {
          assert.match(ran.stderr, /another save of the settings file is in progress.*if none is running, delete/)
          if (writer === 'plugin') assert.equal(ran.status, SETTINGS_LOCKED)
        }
        assert.ok(ran.stderr.includes(lock), ran.stderr)
        assert.deepEqual(readFileSync(file), Buffer.from(lockBase))
        assert.deepEqual(lockSnapshot(lock), before)
        if (targetBefore !== null) assert.deepEqual(lockSnapshot(target), targetBefore)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }

  test(`${writer} saves after a lock is removed while it waits`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-lock-release-'))
    try {
      const { file, lock } = oldLock(dir, 'empty')
      const preload = join(dir, 'waiting.cjs')
      writeFileSync(preload, `const fs = require('node:fs')
const open = fs.openSync
let said = false
fs.openSync = (...args) => {
  try { return open(...args) } catch (error) {
    if (!said && String(args[0]) === ${JSON.stringify(lock)} && error.code === 'EEXIST') { said = true; process.stdout.write('WAITING\\n') }
    throw error
  }
}
require('node:module').syncBuiltinESMExports()
`)
      let removal
      const ran = await runLockChild(writer, file, { preload, onWaiting: () => { removal = setTimeout(() => unlinkSync(lock), 500) } })
      clearTimeout(removal)
      assert.equal(ran.timedOut, false, ran.stderr)
      assert.equal(ran.waiting, true, 'the child encountered the existing lock')
      assert.ok(ran.elapsed < 3000, `save took ${ran.elapsed} ms`)
      assert.equal(ran.status, 0, ran.stderr)
      assert.equal(readFileSync(file, 'utf8'), lockNext)
      assert.equal(existsSync(lock), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${writer} removes its lock and passes through a callback error`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-lock-throw-'))
    try {
      const file = join(dir, 'progress-settings.json')
      const ran = await runLockChild(writer, file, { callback: "throw new Error('synthetic callback failure')" })
      assert.equal(ran.timedOut, false)
      assert.equal(ran.status, 1)
      assert.match(ran.stderr, /synthetic callback failure/)
      assert.equal(existsSync(`${file}.agent-board.lock`), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test(`${writer} leaves a foreign lock swapped in during the callback`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-lock-swap-'))
    try {
      const file = join(dir, 'progress-settings.json')
      const ran = await runLockChild(writer, file, { callback: "fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, 'foreign lock'); return 0" })
      assert.equal(ran.timedOut, false, ran.stderr)
      assert.equal(ran.status, 0, ran.stderr)
      assert.equal(readFileSync(`${file}.agent-board.lock`, 'utf8'), 'foreign lock')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('each language names the lock path and tells the person when to delete it', () => {
  const lock = '/synthetic/progress-settings.json.agent-board.lock'
  for (const words of [EN, ZH_TW, ZH_CN]) assert.ok(words.settingsLocked(lock).includes(lock))
  assert.match(EN.settingsLocked(lock), /in progress.*stopped.*If no save is running, delete/)
})

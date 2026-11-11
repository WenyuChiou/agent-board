import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { EN } from '../hooks/strings-en.ts'
import { SETTINGS_CHANGED, SETTINGS_READ, SETTINGS_UNSAFE, SETTINGS_WRITE } from '../hooks/settings-script.ts'
import { readSettings, replaceSettings, updateSettings } from '../scripts/settings-file.ts'

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
    const write = (next, kind, base) => spawnSync(process.execPath, ['-e', SETTINGS_WRITE, '--', settings, next, kind, base], { timeout: 5000, encoding: 'utf8' }).status
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
    const script = (next, kind, base) => spawnSync(process.execPath, ['-e', SETTINGS_WRITE, '--', settings, next, kind, base], { timeout: 5000, encoding: 'utf8' }).status
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
    const wrote = spawnSync(process.execPath, ['-e', SETTINGS_WRITE, '--', settings, '{}', 'missing', ''], { timeout: 5000, encoding: 'utf8' })
    assert.equal(wrote.error, undefined)
    assert.equal(wrote.status, SETTINGS_UNSAFE)
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
    const write = (text, kind = 'missing', base = '') => spawnSync(process.execPath, ['-e', SETTINGS_WRITE, '--', settings, text, kind, base], { timeout: 5000, encoding: 'utf8' }).status
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

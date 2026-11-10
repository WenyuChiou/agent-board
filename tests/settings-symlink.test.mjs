import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { EN } from '../hooks/strings-en.ts'

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

test('saveBarStyle refuses a symlinked or non-regular settings file without overwriting target (#1261)', async () => {
  const board = await serve()
  try {
    const settings = join(board.dir, 'progress-settings.json')
    const victim = join(board.dir, 'victim-style.txt')
    writeFileSync(victim, 'sensitive target content')

    let hasSymlink = true
    try {
      symlinkSync(victim, settings)
    } catch {
      hasSymlink = false
    }

    if (hasSymlink) {
      const res = await board.call('POST', '/api/style', { body: { style: 'blue' } })
      assert.equal(res.status, 409)
      assert.equal(res.json().note, EN.barStyleUnreadable)
      assert.equal(readFileSync(victim, 'utf8'), 'sensitive target content')
      unlinkSync(settings)
    }

    mkdirSync(settings)
    const dirRes = await board.call('POST', '/api/style', { body: { style: 'blue' } })
    assert.equal(dirRes.status, 409)
    assert.equal(dirRes.json().note, EN.barStyleUnreadable)
    rmdirSync(settings)
  } finally {
    await board.close()
  }
})

test('saveLanguage refuses a symlinked or non-regular settings file without overwriting target (#1261)', async () => {
  const board = await serve()
  try {
    const settings = join(board.dir, 'progress-settings.json')
    const victim = join(board.dir, 'victim-lang.txt')
    writeFileSync(victim, 'sensitive target content')

    let hasSymlink = true
    try {
      symlinkSync(victim, settings)
    } catch {
      hasSymlink = false
    }

    if (hasSymlink) {
      const res = await board.call('POST', '/api/language', { body: { lang: 'zh-TW' } })
      assert.equal(res.status, 409)
      assert.equal(res.json().note, EN.barStyleUnreadable)
      assert.equal(readFileSync(victim, 'utf8'), 'sensitive target content')
      unlinkSync(settings)
    }

    mkdirSync(settings)
    const dirRes = await board.call('POST', '/api/language', { body: { lang: 'zh-TW' } })
    assert.equal(dirRes.status, 409)
    assert.equal(dirRes.json().note, EN.barStyleUnreadable)
    rmdirSync(settings)
  } finally {
    await board.close()
  }
})

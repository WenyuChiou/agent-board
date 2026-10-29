import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

test('configurable staleness allows completion and archive on quiet sessions and forbids them when active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-stale-test-'))
  try {
    const path = join(dir, 'progress.md')
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const taskContent = (updated) => `# Progress\n\n## Demo Project\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${updated} -->\n### Quiet task\n- [ ] Finish work\n<!-- /auto session=a1b2c3d4 -->\n`
    
    writeFileSync(path, taskContent(tenMinAgo))
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    
    const run = (extraArgs) => execFileSync(process.execPath, [script, ...extraArgs], {
      env: { ...process.env, CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1' },
      encoding: 'utf8'
    })

    // 1. Without --stale-ms (default 12 hours), the 10-minute old task is considered working (not stopped)
    // Running with 'i d' finds no stopped row to confirm done
    const defaultOut = run(['--keys', 'i d'])
    assert.equal(defaultOut.includes('Confirmed “Quiet task” done.'), false)

    // 2. With --stale-ms 300000 (5 minutes), the 10-minute old task is recognized as stopped and 'd' confirms it
    const staleOut = run(['--stale-ms', '300000', '--keys', 'i d'])
    assert.ok(staleOut.includes('Confirmed “Quiet task” done.'), staleOut)
    assert.ok(readFileSync(path, 'utf8').includes('state=done'))

    // 3. Test archiving: reset to working at 10 minutes ago
    writeFileSync(path, taskContent(tenMinAgo))
    const archiveOut = run(['--stale-ms', '300000', '--keys', 'i a'])
    assert.ok(archiveOut.includes('Archived “Quiet task”.'), archiveOut)
    assert.equal(readFileSync(path, 'utf8').includes('Quiet task'), false)

    // 4. When updated now (active again), confirmation and archive are refused even with --stale-ms 300000
    writeFileSync(path, taskContent(new Date().toISOString()))
    const activeOut = run(['--stale-ms', '300000', '--keys', 'i a'])
    assert.equal(activeOut.includes('Archived “Quiet task”.'), false)
    assert.ok(readFileSync(path, 'utf8').includes('Quiet task'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--serve forwards --stale-ms to the background browser child', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-serve-stale-'))
  const run = join(dir, 'run')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(run, { mode: 0o700 })
  if (process.platform === 'win32') mkdirSync(join(run, 'agent-board'))

  const path = join(dir, 'progress.md')
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  writeFileSync(path, `# Progress\n\n## Demo Project\n<!-- auto session=b2c3d4e5 agent=codex state=working updated=${tenMinAgo} -->\n### Quiet browser task\n- [ ] Finish work\n<!-- /auto session=b2c3d4e5 -->\n`)

  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${BOARD_SCRIPT}`)

  const home = join(dir, 'home')
  const temp = join(dir, 'tmp')
  mkdirSync(home)
  mkdirSync(temp)
  const machine = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec']
  const env = {
    ...Object.fromEntries(machine.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    CLAUDE_PROGRESS_FILE: '', NO_COLOR: '1', XDG_RUNTIME_DIR: run,
  }

  let url = null
  try {
    const out = await new Promise((done, fail) => {
      execFile(process.execPath, [script, '--serve', '--no-open', '--stale-ms', '300000'], { env, encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
        if (error) fail(error)
        else done(stdout)
      })
    })

    url = out.match(/answer\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/)?.[1] ?? null
    assert.ok(url, out)

    // Query the server API to verify that the 10-minute quiet session appears in stopped sessions
    const { port, searchParams } = new URL(url)
    const token = searchParams.get('t')
    const boardJson = await new Promise((done, fail) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/board', headers: { host: `127.0.0.1:${port}`, 'x-board-token': token } }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => done(JSON.parse(body)))
      })
      req.on('error', fail)
      req.end()
    })

    assert.ok(boardJson.model?.stopped && boardJson.model.stopped.length > 0, 'stopped tasks must include the quiet session')
    assert.equal(boardJson.model.stopped[0].title, 'Quiet browser task')

    // Close the server
    await new Promise(done => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/close', headers: { host: `127.0.0.1:${port}`, 'x-board-token': token, 'content-type': 'application/json' } }, res => res.resume().on('end', done))
      req.on('error', done)
      req.end('{}')
    })
  } finally {
    await new Promise(done => setTimeout(done, 1000))
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)
  }
})

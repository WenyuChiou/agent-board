import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CHECKS, DESKTOP_CHECKLIST_PATH, SHAPES, SURFACES, buildThrowawayHome, formatMatrixTable, runMatrix, spawnSpecFor } from '../../scripts/matrix-runner.mjs'

const tempRoots = []
const makeTempDir = prefix => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const snapshotTree = root => {
  const out = []
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      const stat = statSync(full)
      out.push({ path: full.slice(root.length), isDir: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs })
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out
}

const standInScripts = () => {
  const dir = makeTempDir('matrix-standin-cli-')
  const messageClientUrl = pathToFileURL(join(process.cwd(), 'scripts', 'message-client.mjs')).href
  const responder = join(dir, 'standin-responder.mjs')
  const silent = join(dir, 'standin-silent.mjs')

  writeFileSync(responder, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { boardClient } from ${JSON.stringify(messageClientUrl)}

const url = process.env.AGENT_BOARD_URL
const token = new URL(url).searchParams.get('t')
const origin = new URL(url).origin
const agent = process.env.AGENT_BOARD_MATRIX_AGENT
const surface = process.env.AGENT_BOARD_MATRIX_SURFACE
const mode = process.env.AGENT_BOARD_MATRIX_MODE
const session = process.env.AGENT_BOARD_MATRIX_SESSION
const progress = process.env.AGENT_BOARD_MATRIX_PROGRESS
const question = process.env.AGENT_BOARD_MATRIX_QUESTION
const expectedReply = process.env.AGENT_BOARD_MATRIX_REPLY
const blockId = session.slice(-8)

const writeBlock = (state, answerLine) => {
  const now = new Date(Date.now() - 1000).toISOString()
  const stepLine = state === 'done'
    ? '- [x] ' + question + '\\n- [x] Answered: ' + answerLine
    : '- [?] ' + question
  const block = '## Synthetic matrix\\n<!-- auto session=' + blockId + ' agent=' + agent + ' state=' + state + ' updated=' + now + ' resume=' + session + ' -->\\n### Matrix task\\n' + stepLine + '\\n<!-- /auto session=' + blockId + ' -->\\n'
  writeFileSync(progress, block, 'utf8')
}

writeBlock('waiting', '')

if (mode === 'live') {
  let done = false
  const handle = await boardClient(url).attach({
    agent,
    session,
    surface,
    turn: 'session',
    scope: 'session',
    pollMs: 40,
    verify: async () => true,
    deliver: async (msg, accept) => {
      await accept()
      writeBlock('done', msg.text || expectedReply)
      done = true
      return 'ACK ' + msg.nonce + ' ' + msg.text
    },
  })
  const until = Date.now() + 9000
  while (!done && Date.now() < until) await new Promise(r => setTimeout(r, 30))
  await new Promise(r => setTimeout(r, 150))
  await handle.close()
} else {
  const headers = { 'x-board-token': token, 'content-type': 'application/json' }
  const callMsg = (action, body) => fetch(new URL('/api/messages/' + action, origin), { method: 'POST', headers, body: JSON.stringify(body) }).then(r => r.json())
  const until = Date.now() + 9000
  while (Date.now() < until) {
    const taken = await callMsg('mailbox-turn', { agent, session, surface })
    if (taken?.message) {
      const m = taken.message
      await callMsg('mailbox-accept', { agent, session, id: m.id, nonce: m.nonce })
      writeBlock('done', m.text || expectedReply)
      await callMsg('mailbox-ack', { agent, session, id: m.id, nonce: m.nonce, reply: 'ACK ' + m.nonce + ' ' + m.text })
      break
    }
    await new Promise(r => setTimeout(r, 40))
  }
}
`, 'utf8')

  writeFileSync(silent, `
import { writeFileSync } from 'node:fs'
import { boardClient } from ${JSON.stringify(messageClientUrl)}

const url = process.env.AGENT_BOARD_URL
const token = new URL(url).searchParams.get('t')
const origin = new URL(url).origin
const agent = process.env.AGENT_BOARD_MATRIX_AGENT
const surface = process.env.AGENT_BOARD_MATRIX_SURFACE
const mode = process.env.AGENT_BOARD_MATRIX_MODE
const session = process.env.AGENT_BOARD_MATRIX_SESSION
const progress = process.env.AGENT_BOARD_MATRIX_PROGRESS
const question = process.env.AGENT_BOARD_MATRIX_QUESTION
const blockId = session.slice(-8)
const now = new Date(Date.now() - 1000).toISOString()
writeFileSync(progress, '## Synthetic matrix\\n<!-- auto session=' + blockId + ' agent=' + agent + ' state=waiting updated=' + now + ' resume=' + session + ' -->\\n### Silent task\\n- [?] ' + question + '\\n<!-- /auto session=' + blockId + ' -->\\n', 'utf8')

if (mode === 'live') {
  const handle = await boardClient(url).attach({
    agent,
    session,
    surface,
    turn: 'session',
    scope: 'session',
    pollMs: 5000,
    verify: async () => true,
    deliver: async () => {
      await new Promise(r => setTimeout(r, 5000))
      return ''
    },
  })
  await new Promise(r => setTimeout(r, 5000))
  await handle.close()
} else {
  const headers = { 'x-board-token': token, 'content-type': 'application/json' }
  await fetch(new URL('/api/messages/mailbox-turn', origin), { method: 'POST', headers, body: JSON.stringify({ agent, session, surface }) })
  await new Promise(r => setTimeout(r, 5000))
}
`, 'utf8')

  return { responder, silent }
}

test('the runner builds a throwaway home for each install shape and never writes to the real home', async () => {
  const realHome = makeTempDir('matrix-real-home-')
  const sentinel = join(realHome, '.agent-board')
  mkdirSync(sentinel, { recursive: true })
  writeFileSync(join(sentinel, 'progress.md'), 'real-home-untouched\n', 'utf8')
  const beforeReal = snapshotTree(realHome)

  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  const prevProgress = process.env.CLAUDE_PROGRESS_FILE
  const prevRuntime = process.env.XDG_RUNTIME_DIR
  process.env.HOME = realHome
  process.env.USERPROFILE = realHome
  process.env.CLAUDE_PROGRESS_FILE = join(sentinel, 'progress.md')
  process.env.XDG_RUNTIME_DIR = join(realHome, 'real-runtime')

  try {
    const tempBase = makeTempDir('matrix-throwaway-base-')
    const homes = []
    for (const shape of SHAPES) {
      const h = buildThrowawayHome({ shape, tempBase })
      homes.push(h)
      assert.ok(!h.home.startsWith(realHome), `shape ${shape} home must be separate from real home`)
      assert.equal(h.env.HOME, h.home)
      assert.equal(h.env.USERPROFILE, h.home)
      assert.equal(h.env.CLAUDE_PROGRESS_FILE, h.progress)
      assert.ok(h.env.XDG_RUNTIME_DIR.startsWith(h.root), `XDG_RUNTIME_DIR must stay inside throwaway root`)
      assert.notEqual(h.env.XDG_RUNTIME_DIR, process.env.XDG_RUNTIME_DIR)
      assert.equal(existsSync(h.script), true)
      if (shape === 'S') assert.equal(h.progress, join(h.home, '.agent-board', 'progress.md'))
      else assert.equal(h.progress, join(h.home, '.claude', 'agent-board', 'progress.md'))
    }
    assert.notEqual(homes[0].root, homes[1].root)
    for (const h of homes) h.cleanup()
    for (const h of homes) assert.equal(existsSync(h.root), false)
    assert.deepEqual(snapshotTree(realHome), beforeReal)
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile
    if (prevProgress === undefined) delete process.env.CLAUDE_PROGRESS_FILE; else process.env.CLAUDE_PROGRESS_FILE = prevProgress
    if (prevRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prevRuntime
  }
})

test("a stand-in CLI that receives the board's reply marks its cell PASS, and one that never does marks FAIL with the step it stopped at", { timeout: 60_000 }, async () => {
  const { responder, silent } = standInScripts()
  const tempBase = makeTempDir('matrix-journey-base-')
  const claudeSurface = SURFACES.filter(one => one.id === 'claude-cli')

  const passRun = await runMatrix({
    shapes: ['S'],
    surfaces: claudeSurface,
    cliFor: () => ({ command: process.execPath, args: [responder] }),
    version: '0.26.0-test',
    date: '2026-11-24',
    timeoutMs: 8000,
    tempBase,
  })
  assert.equal(passRun.rows.length, 4)
  for (const row of passRun.rows) assert.equal(row.result, 'PASS', `expected PASS for ${row.check}, got ${row.result}: ${row.evidence}`)

  const failRun = await runMatrix({
    shapes: ['S'],
    surfaces: claudeSurface,
    cliFor: () => ({ command: process.execPath, args: [silent] }),
    version: '0.26.0-test',
    date: '2026-11-24',
    timeoutMs: 1200,
    tempBase,
  })
  assert.equal(failRun.rows.length, 4)
  assert.equal(failRun.rows[0].result, 'PASS')
  assert.equal(failRun.rows[1].result, 'PASS')
  assert.equal(failRun.rows[2].result, 'FAIL')
  assert.match(failRun.rows[2].evidence, /stopped at c:/i)
  assert.equal(failRun.rows[3].result, 'FAIL')
  assert.match(failRun.rows[3].evidence, /stopped at c:/i)

  const twoCliSurfaces = SURFACES.filter(one => one.id === 'claude-cli' || one.id === 'codex-cli')
  const mixedRun = await runMatrix({
    shapes: ['S'],
    surfaces: twoCliSurfaces,
    cliFor: surface => surface.id === 'claude-cli'
      ? { command: join(tempBase, 'missing-nonexistent-cli-binary') }
      : { command: process.execPath, args: [responder] },
    version: '0.26.0-test',
    date: '2026-11-24',
    timeoutMs: 8000,
    tempBase,
  })
  assert.equal(mixedRun.rows.length, 8)
  assert.equal(mixedRun.rows[0].result, 'PASS')
  assert.equal(mixedRun.rows[1].result, 'FAIL')
  assert.match(mixedRun.rows[1].evidence, /stopped at b:/i)
  for (const row of mixedRun.rows.slice(4)) assert.equal(row.result, 'PASS', `expected matrix to continue after spawn error, got ${row.result}: ${row.evidence}`)

  const winSpec = spawnSpecFor({ command: 'C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd', args: ['--flag', 'a b'] }, 'win32')
  assert.match(winSpec.command, /cmd(?:\.exe)?$/i)
  assert.equal(winSpec.windowsVerbatimArguments, true)
  assert.deepEqual(winSpec.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.match(winSpec.args[3], /codex\.cmd/)
  assert.throws(() => spawnSpecFor({ command: 'C:\\demo\\bad.cmd', args: ['line1\nline2'] }, 'win32'))

  if (process.platform === 'win32') {
    const cmdWrapper = join(tempBase, 'standin-cli.cmd')
    writeFileSync(cmdWrapper, `@echo off\r\n"${process.execPath}" "${responder}" %*\r\n`)
    const winRun = await runMatrix({
      shapes: ['S'],
      surfaces: [SURFACES.find(one => one.id === 'claude-cli')],
      cliFor: () => ({ command: cmdWrapper }),
      version: '0.26.0-test',
      date: '2026-11-24',
      timeoutMs: 8000,
      tempBase,
    })
    assert.equal(winRun.rows.length, 4)
    for (const row of winRun.rows) assert.equal(row.result, 'PASS', `Windows .cmd wrapper failed ${row.check}: ${row.evidence}`)
  }
})

test('the table has one row per cell with date, version, shape, result and evidence', { timeout: 120_000 }, async () => {
  const { responder } = standInScripts()
  const tempBase = makeTempDir('matrix-full-base-')
  const result = await runMatrix({
    shapes: SHAPES,
    surfaces: SURFACES,
    cliFor: () => ({ command: process.execPath, args: [responder] }),
    version: '0.26.0-test',
    date: '2026-11-24',
    timeoutMs: 8000,
    tempBase,
  })

  // 7 surfaces x 4 checks x 2 install shapes = 56 cells.
  assert.equal(result.rows.length, SURFACES.length * CHECKS.length * SHAPES.length)
  for (const row of result.rows) {
    assert.equal(row.date, '2026-11-24')
    assert.equal(row.version, '0.26.0-test')
    assert.ok(SHAPES.includes(row.shape))
    assert.ok(row.surface)
    assert.ok(row.check)
    assert.ok(row.evidence)
    if (SURFACES.find(s => s.name === row.surface)?.kind === 'desktop') {
      assert.equal(row.result, 'CHECKLIST')
      assert.ok(row.evidence.includes(DESKTOP_CHECKLIST_PATH))
    } else {
      assert.equal(row.result, 'PASS', `${row.shape} ${row.surface} ${row.check}: ${row.evidence}`)
    }
  }

  const lines = formatMatrixTable(result.rows).trim().split('\n')
  assert.equal(lines[0], '| Date | Version | Shape | Surface | Check | Result | Evidence |')
  assert.equal(lines.length, result.rows.length + 2)
})

import { spawn } from 'node:child_process'
import { request } from 'node:http'
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const RECENT = '2026-10-20T11:50:00Z'

const archiveName = (now = NOW) => {
  const date = new Date(now)
  return `progress-archive-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.md`
}

const journalName = (now = NOW) => {
  const date = new Date(now)
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  return `progress-journal-${month}-${String(date.getDate()).padStart(2, '0')}.md`
}

const startBoard = async (initialProgress, now = NOW) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-undo-'))
  const run = join(dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  const path = join(dir, 'progress.md')
  writeFileSync(path, initialProgress)
  const script = join(dir, 'agent-board.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\nDate.now = () => ${now}\n${BOARD_SCRIPT}`)
  const child = spawn(process.execPath, [script, '--serve-child'], {
    env: {
      ...process.env,
      CLAUDE_PROGRESS_FILE: '',
      HOME: dir,
      USERPROFILE: dir,
      TEMP: dir,
      TMP: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      NO_COLOR: '1',
      AGENT_BOARD_TEST_PID: String(process.pid),
      XDG_RUNTIME_DIR: run,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(done => child.once('exit', code => done(code)))
  const url = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      out += chunk
      if (out.includes('\n')) resolve(new URL(out.split('\n')[0].trim()))
    })
    exited.then(code => reject(new Error(`the server exited with ${code}: ${stderr}`)))
  })
  const port = Number(url.port)
  const token = url.searchParams.get('t')
  const call = (method, target, body) =>
    new Promise((resolve, reject) => {
      const sent = {
        host: `127.0.0.1:${port}`,
        'x-board-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }
      const req = request({ host: '127.0.0.1', port, method, path: target, headers: sent, agent: false }, res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }))
      })
      req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP request timed out')))
      req.on('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const rows = async () => {
    const model = (await call('GET', '/api/board')).json().model
    return [...model.groups.flatMap(group => group.rows), ...model.stopped]
  }
  const rowOf = async title => (await rows()).find(row => row.title === title)
  const close = async () => {
    try {
      if (child.exitCode === null) await call('POST', '/api/close', {}).catch(() => undefined)
      const code = await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 4000))])
      if (code === 'still running') {
        child.kill()
        await Promise.race([exited, new Promise(done => setTimeout(() => done('still running'), 4000))])
      }
    } finally {
      if (child.exitCode === null) child.kill()
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  return { dir, path, call, rows, rowOf, close }
}

const autoStopped = (session, project, title, steps = ['- [x] First step', '- [ ] Finish synthetic report']) =>
  `<!-- auto session=${session} agent=codex state=ended updated=${RECENT} -->\n### ${title}\n${steps.join('\n')}\n<!-- /auto session=${session} -->\n`

test('Undo after Confirm done puts the block back as it was', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('a1b2c3d4', 'api-gateway', 'Ended Codex task')}\n` +
    `## notes-app\n### Stopped manual task\n- [x] Drafted outline\n- [ ] Verify release notes\n`
  const board = await startBoard(initial)
  try {
    const before = readFileSync(board.path, 'utf8')
    const stopped = await board.rowOf('Ended Codex task')
    assert.ok(stopped && stopped.canConfirm)
    const pressed = await board.call('POST', '/api/act', { key: stopped.key, type: 'done', fp: stopped.fp })
    assert.equal(pressed.status, 200, pressed.body)
    assert.equal(pressed.json().canUndo, true)
    assert.notEqual(readFileSync(board.path, 'utf8'), before)
    const journalPath = join(board.dir, journalName())
    assert.ok(readFileSync(journalPath, 'utf8').includes('Finish synthetic report'))

    const undone = await board.call('POST', '/api/undo', {})
    assert.equal(undone.status, 200, undone.body)
    assert.equal(undone.json().ok, true)
    assert.match(undone.json().note, /Restored.*Ended Codex task/)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    const journalAfter = fs.existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
    assert.ok(!journalAfter.includes('Finish synthetic report'), `journal still kept entry: ${journalAfter}`)

    // Also verify Confirm done + Undo on a hand-kept stopped manual task when an auto block is not involved.
    const manual = await board.rowOf('Stopped manual task')
    assert.ok(manual && manual.canConfirm)
    const manualBefore = readFileSync(board.path, 'utf8')
    const manualPressed = await board.call('POST', '/api/act', { key: manual.key, type: 'done', fp: manual.fp })
    assert.equal(manualPressed.status, 200, manualPressed.body)
    assert.equal(manualPressed.json().canUndo, true)
    const manualUndone = await board.call('POST', '/api/undo', {})
    assert.equal(manualUndone.status, 200, manualUndone.body)
    assert.equal(readFileSync(board.path, 'utf8'), manualBefore)
  } finally { await board.close() }
})

test('Undo after Archive puts the task back and removes its archive entry', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## solo-project\n${autoStopped('b2c3d4e5', 'solo-project', 'Archiveable task', ['- [x] Built patch', '- [ ] Push tag'])}\n`
  const board = await startBoard(initial)
  try {
    const before = readFileSync(board.path, 'utf8')
    const row = await board.rowOf('Archiveable task')
    assert.ok(row && row.canArchive)
    const archived = await board.call('POST', '/api/act', { key: row.key, type: 'archive', fp: row.fp })
    assert.equal(archived.status, 200, archived.body)
    assert.equal(archived.json().canUndo, true)
    assert.equal(readFileSync(board.path, 'utf8'), '')
    const archFile = join(board.dir, archiveName())
    assert.ok(readFileSync(archFile, 'utf8').includes('Archiveable task'))

    const undone = await board.call('POST', '/api/undo', {})
    assert.equal(undone.status, 200, undone.body)
    assert.equal(undone.json().ok, true)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    const archAfter = fs.existsSync(archFile) ? readFileSync(archFile, 'utf8') : ''
    assert.ok(!archAfter.includes('Archiveable task'), `archive still contains undone entry: ${archAfter}`)
  } finally { await board.close() }
})

test('Undo refuses with the reason when the block changed after the press', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('c3d4e5f6', 'api-gateway', 'Changed later')}\n`
  const board = await startBoard(initial)
  try {
    const row = await board.rowOf('Changed later')
    const pressed = await board.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })
    assert.equal(pressed.status, 200, pressed.body)
    const edited = readFileSync(board.path, 'utf8').replace('Finish synthetic report', 'Edited by another writer')
    writeFileSync(board.path, edited)

    const refused = await board.call('POST', '/api/undo', {})
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().ok, false)
    assert.equal(refused.json().note, 'Could not undo: that task changed since your press.')
    assert.equal(readFileSync(board.path, 'utf8'), edited)
  } finally { await board.close() }
})

test('Undo refuses when the block is gone', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('d4e5f6a7', 'api-gateway', 'Vanishing task')}\n\n## other\n### Keeper\n- [ ] Keep this\n`
  const board = await startBoard(initial)
  try {
    const row = await board.rowOf('Vanishing task')
    const pressed = await board.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })
    assert.equal(pressed.status, 200, pressed.body)
    const withoutTask = '# Progress\n\n## other\n### Keeper\n- [ ] Keep this\n'
    writeFileSync(board.path, withoutTask)

    const refused = await board.call('POST', '/api/undo', {})
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().ok, false)
    assert.equal(refused.json().note, 'Could not undo: that task is no longer on the board.')
    assert.equal(readFileSync(board.path, 'utf8'), withoutTask)
  } finally { await board.close() }
})

test('a second Undo has nothing to undo', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('e5f6a7b8', 'api-gateway', 'Single undo')}\n`
  const board = await startBoard(initial)
  try {
    const empty = await board.call('POST', '/api/undo', {})
    assert.equal(empty.status, 409, empty.body)
    assert.equal(empty.json().ok, false)
    assert.equal(empty.json().note, 'Nothing to undo.')

    const before = readFileSync(board.path, 'utf8')
    const row = await board.rowOf('Single undo')
    assert.equal((await board.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })).status, 200)
    assert.equal((await board.call('POST', '/api/undo', {})).status, 200)
    assert.equal(readFileSync(board.path, 'utf8'), before)

    const second = await board.call('POST', '/api/undo', {})
    assert.equal(second.status, 409, second.body)
    assert.equal(second.json().ok, false)
    assert.equal(second.json().note, 'Nothing to undo.')
  } finally { await board.close() }
})

test('Undo after Archive refuses when the archive entry changed since', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('f6a7b8c9', 'api-gateway', 'Edited archive')}\n`
  const board = await startBoard(initial)
  try {
    const row = await board.rowOf('Edited archive')
    assert.equal((await board.call('POST', '/api/act', { key: row.key, type: 'archive', fp: row.fp })).status, 200)
    const afterArchiveProgress = readFileSync(board.path, 'utf8')
    const archFile = join(board.dir, archiveName())
    const editedArchive = readFileSync(archFile, 'utf8').replace('Edited archive', 'Edited in archive')
    writeFileSync(archFile, editedArchive)

    const refused = await board.call('POST', '/api/undo', {})
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().ok, false)
    assert.equal(refused.json().note, 'Could not undo: that task changed since your press.')
    assert.equal(readFileSync(board.path, 'utf8'), afterArchiveProgress)
    assert.equal(readFileSync(archFile, 'utf8'), editedArchive)
  } finally { await board.close() }
})

test('Undo after Confirm done or Archive keeps an unrelated block written meanwhile', { timeout: 30_000 }, async () => {
  const otherBlock = `<!-- auto session=11223344 agent=claude state=working updated=${RECENT} -->\n### Concurrent session\n- [~] Running elsewhere\n<!-- /auto session=11223344 -->\n`
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('a2b3c4d5', 'api-gateway', 'Target task')}\n`
  const board = await startBoard(initial)
  try {
    // Case A: Confirm done then concurrent block added to the same project
    const rowDone = await board.rowOf('Target task')
    assert.equal((await board.call('POST', '/api/act', { key: rowDone.key, type: 'done', fp: rowDone.fp })).status, 200)
    writeFileSync(board.path, `${readFileSync(board.path, 'utf8').trimEnd()}\n\n${otherBlock}`)
    const undoDone = await board.call('POST', '/api/undo', {})
    assert.equal(undoDone.status, 200, undoDone.body)
    const afterDoneUndo = readFileSync(board.path, 'utf8')
    assert.ok(afterDoneUndo.includes('- [ ] Finish synthetic report'), afterDoneUndo)
    assert.ok(afterDoneUndo.includes('Concurrent session'), afterDoneUndo)

    // Case B: Archive while unrelated section stays untouched and gets updated concurrently
    const rowArchive = await board.rowOf('Target task')
    assert.equal((await board.call('POST', '/api/act', { key: rowArchive.key, type: 'archive', fp: rowArchive.fp })).status, 200)
    writeFileSync(board.path, readFileSync(board.path, 'utf8').replace('Running elsewhere', 'Updated concurrent step'))
    const undoArchive = await board.call('POST', '/api/undo', {})
    assert.equal(undoArchive.status, 200, undoArchive.body)
    const afterArchiveUndo = readFileSync(board.path, 'utf8')
    assert.ok(afterArchiveUndo.includes('Target task'), afterArchiveUndo)
    assert.ok(afterArchiveUndo.includes('Updated concurrent step'), afterArchiveUndo)
    const archFile = join(board.dir, archiveName())
    assert.ok(!readdirSync(board.dir).includes(archiveName()) || !readFileSync(archFile, 'utf8').includes('Target task'))
  } finally { await board.close() }
})

test('any later press on the board drops the Undo record', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('b3c4d5e6', 'api-gateway', 'Confirmed first')}\n\n## notes-app\n### Next press\n- [ ] Tick this later\n`
  const board = await startBoard(initial)
  try {
    const first = await board.rowOf('Confirmed first')
    const second = await board.rowOf('Next press')
    assert.ok(first && second)
    assert.equal((await board.call('POST', '/api/act', { key: first.key, type: 'done', fp: first.fp })).status, 200)
    const ticked = await board.call('POST', '/api/act', { key: second.key, type: 'tick', text: 'Tick this later', fp: second.tickFp ?? second.fp, line: second.nextFileLine })
    assert.equal(ticked.status, 200, ticked.body)
    assert.equal(ticked.json().canUndo ?? false, false)

    const afterTickProgress = readFileSync(board.path, 'utf8')
    const undo = await board.call('POST', '/api/undo', {})
    assert.equal(undo.status, 409, undo.body)
    assert.equal(undo.json().note, 'Nothing to undo.')
    assert.equal(readFileSync(board.path, 'utf8'), afterTickProgress)
  } finally { await board.close() }
})

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

const journalFileIn = dir => {
  const name = readdirSync(dir).find(one => one.startsWith('progress-journal-') && one.endsWith('.md'))
  return name ? join(dir, name) : null
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
    assert.ok(pressed.json().undoToken)
    assert.notEqual(readFileSync(board.path, 'utf8'), before)
    const journalPath = journalFileIn(board.dir)
    assert.ok(journalPath !== null && readFileSync(journalPath, 'utf8').includes('Finish synthetic report'))

    const undone = await board.call('POST', '/api/undo', { token: pressed.json().undoToken })
    assert.equal(undone.status, 200, undone.body)
    assert.equal(undone.json().ok, true)
    assert.match(undone.json().note, /Restored.*Ended Codex task/)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    const journalAfter = journalPath && fs.existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
    assert.ok(!journalAfter.includes('Finish synthetic report'), `journal still kept entry: ${journalAfter}`)

    // Also verify Confirm done + Undo on a hand-kept stopped manual task when an auto block is not involved.
    const manual = await board.rowOf('Stopped manual task')
    assert.ok(manual && manual.canConfirm)
    const manualBefore = readFileSync(board.path, 'utf8')
    const manualPressed = await board.call('POST', '/api/act', { key: manual.key, type: 'done', fp: manual.fp })
    assert.equal(manualPressed.status, 200, manualPressed.body)
    assert.equal(manualPressed.json().canUndo, true)
    const manualUndone = await board.call('POST', '/api/undo', { token: manualPressed.json().undoToken })
    assert.equal(manualUndone.status, 200, manualUndone.body)
    assert.equal(readFileSync(board.path, 'utf8'), manualBefore)

    // Regression: failed journal rollback surfaces 409 and retains token so retry cleans journal.
    const jBefore = readFileSync(board.path, 'utf8')
    const jDone = await board.call('POST', '/api/act', { key: stopped.key, type: 'done', fp: stopped.fp })
    assert.equal(jDone.status, 200, jDone.body)
    const jToken = jDone.json().undoToken
    const jSaved = readFileSync(journalPath, 'utf8')
    fs.unlinkSync(journalPath)
    fs.mkdirSync(journalPath)
    try {
      const partialFail = await board.call('POST', '/api/undo', { token: jToken })
      assert.equal(partialFail.status, 409, partialFail.body)
      assert.equal(partialFail.json().ok, false)
      assert.equal(partialFail.json().retryUndo, true)
    } finally {
      if (fs.existsSync(journalPath) && fs.statSync(journalPath).isDirectory()) fs.rmdirSync(journalPath)
      writeFileSync(journalPath, jSaved)
    }
    const retryOk = await board.call('POST', '/api/undo', { token: jToken })
    assert.equal(retryOk.status, 200, retryOk.body)
    assert.equal(readFileSync(board.path, 'utf8'), jBefore)
    assert.ok(!readFileSync(journalPath, 'utf8').includes('Finish synthetic report'))
  } finally { await board.close() }

  // Regression P1-3: uncategorized manual task above first ## section restores after Confirm done.
  const uncat = await startBoard(`# Progress\n\n### Uncategorized manual\n- [x] Done step\n- [ ] Open manual\n\n## beta\n### Beta task\n- [ ] Keep\n`)
  try {
    const beforeUncat = readFileSync(uncat.path, 'utf8')
    const row = await uncat.rowOf('Uncategorized manual')
    assert.ok(row && row.canConfirm)
    const pUncat = await uncat.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })
    assert.equal(pUncat.status, 200)
    const undone = await uncat.call('POST', '/api/undo', { token: pUncat.json().undoToken })
    assert.equal(undone.status, 200, undone.body)
    assert.equal(readFileSync(uncat.path, 'utf8'), beforeUncat)
  } finally { await uncat.close() }

  // Regression Greptile #2: manual task inside second repeated ## alpha section restores via Confirm done + Undo.
  const dupSec = await startBoard(`# Progress\n\n## alpha\n### Alpha first\n- [ ] Keep\n\n## alpha\n### Alpha second\n- [x] Step 1\n- [ ] Open second\n`)
  try {
    const beforeDup = readFileSync(dupSec.path, 'utf8')
    const row = await dupSec.rowOf('Alpha second')
    assert.ok(row && row.canConfirm)
    const pDup = await dupSec.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })
    assert.equal(pDup.status, 200)
    const uDup = await dupSec.call('POST', '/api/undo', { token: pDup.json().undoToken })
    assert.equal(uDup.status, 200, uDup.body)
    assert.equal(readFileSync(dupSec.path, 'utf8'), beforeDup)
  } finally { await dupSec.close() }
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
    assert.ok(!readFileSync(board.path, 'utf8').includes('Archiveable task'))
    const archFile = join(board.dir, archiveName())
    assert.ok(readFileSync(archFile, 'utf8').includes('Archiveable task'))

    const undone = await board.call('POST', '/api/undo', { token: archived.json().undoToken })
    assert.equal(undone.status, 200, undone.body)
    assert.equal(undone.json().ok, true)
    assert.equal(readFileSync(board.path, 'utf8'), before)
    const archAfter = fs.existsSync(archFile) ? readFileSync(archFile, 'utf8') : ''
    assert.ok(!archAfter.includes('Archiveable task'), `archive still contains undone entry: ${archAfter}`)
  } finally { await board.close() }

  // Regression P1-1 & P1-2: archiving a middle/first section and restoring after concurrent edit keeps section ordering and section boundaries.
  const multi = await startBoard(
    `# Progress\n\n## alpha\n### Alpha sibling\n- [ ] Keep\n\n${autoStopped('a1112222', 'alpha', 'Alpha gone')}\n\n## beta\n### Beta task\n- [ ] Open\n`,
  )
  try {
    const rowA = await multi.rowOf('Alpha gone')
    const pA = await multi.call('POST', '/api/act', { key: rowA.key, type: 'archive', fp: rowA.fp })
    assert.equal(pA.status, 200)
    writeFileSync(multi.path, readFileSync(multi.path, 'utf8').replace('- [ ] Open', '- [ ] Concurrent beta edit'))
    const resA = await multi.call('POST', '/api/undo', { token: pA.json().undoToken })
    assert.equal(resA.status, 200, resA.body)
    const afterA = readFileSync(multi.path, 'utf8')
    assert.ok(afterA.indexOf('Alpha gone') > afterA.indexOf('## alpha') && afterA.indexOf('Alpha gone') < afterA.indexOf('## beta'), afterA)
  } finally { await multi.close() }

  // Archiving the sole task in ## alpha puts ## alpha back before ## beta after a concurrent edit.
  const soloOrder = await startBoard(`# Progress\n\n## alpha\n${autoStopped('a3334444', 'alpha', 'Alpha solo')}\n\n## beta\n### Beta task\n- [ ] Open\n`)
  try {
    const rowSolo = await soloOrder.rowOf('Alpha solo')
    const pSolo = await soloOrder.call('POST', '/api/act', { key: rowSolo.key, type: 'archive', fp: rowSolo.fp })
    assert.equal(pSolo.status, 200)
    writeFileSync(soloOrder.path, readFileSync(soloOrder.path, 'utf8').replace('- [ ] Open', '- [ ] Beta changed'))
    const resSolo = await soloOrder.call('POST', '/api/undo', { token: pSolo.json().undoToken })
    assert.equal(resSolo.status, 200, resSolo.body)
    const afterSolo = readFileSync(soloOrder.path, 'utf8')
    assert.ok(afterSolo.indexOf('## alpha') >= 0 && afterSolo.indexOf('## alpha') < afterSolo.indexOf('## beta'), afterSolo)
  } finally { await soloOrder.close() }

  // Regression Greptile 4725809569: consecutive duplicate ## alpha sections restore #1 before #2 after concurrent ## beta edit.
  const consecDup = await startBoard(`# Progress\n\n## alpha\n${autoStopped('a4445555', 'alpha', 'Alpha solo one')}\n\n## alpha\n### Alpha second keeper\n- [ ] Stay\n\n## beta\n### Beta task\n- [ ] Open\n`)
  try {
    const row1 = await consecDup.rowOf('Alpha solo one')
    const p1 = await consecDup.call('POST', '/api/act', { key: row1.key, type: 'archive', fp: row1.fp })
    assert.equal(p1.status, 200)
    writeFileSync(consecDup.path, readFileSync(consecDup.path, 'utf8').replace('- [ ] Open', '- [ ] Beta edited'))
    const u1 = await consecDup.call('POST', '/api/undo', { token: p1.json().undoToken })
    assert.equal(u1.status, 200, u1.body)
    const after1 = readFileSync(consecDup.path, 'utf8')
    assert.ok(after1.indexOf('Alpha solo one') > 0 && after1.indexOf('Alpha solo one') < after1.indexOf('Alpha second keeper'), after1)
  } finally { await consecDup.close() }

  // Regression Greptile #1: archiving one of two blocks sharing a session still allows Undo.
  const shared = await startBoard(
    `# Progress\n\n## alpha\n<!-- auto session=55aa66bb agent=claude state=working updated=${RECENT} -->\n### Shared live\n- [~] Working\n<!-- /auto session=55aa66bb -->\n\n${autoStopped('55aa66bb', 'alpha', 'Shared ended')}\n`,
  )
  try {
    const beforeShared = readFileSync(shared.path, 'utf8')
    const rowShared = await shared.rowOf('Shared ended')
    assert.ok(rowShared && rowShared.canArchive)
    const pShared = await shared.call('POST', '/api/act', { key: rowShared.key, type: 'archive', fp: rowShared.fp })
    assert.equal(pShared.status, 200, pShared.body)
    const uShared = await shared.call('POST', '/api/undo', { token: pShared.json().undoToken })
    assert.equal(uShared.status, 200, uShared.body)
    assert.equal(readFileSync(shared.path, 'utf8'), beforeShared)
  } finally { await shared.close() }

  // Regression Greptile #4: repeated ### Repeat sibling headings restore archived target between them.
  const repSib = await startBoard(
    `# Progress\n\n## alpha\n### Repeat\n- [ ] First\n\n${autoStopped('77cc88dd', 'alpha', 'Middle target')}\n\n### Repeat\n- [ ] Second\n\n## beta\n### Beta task\n- [ ] Open\n`,
  )
  try {
    const rowMid = await repSib.rowOf('Middle target')
    const pMid = await repSib.call('POST', '/api/act', { key: rowMid.key, type: 'archive', fp: rowMid.fp })
    assert.equal(pMid.status, 200)
    writeFileSync(repSib.path, readFileSync(repSib.path, 'utf8').replace('- [ ] Open', '- [ ] Beta moved'))
    const uMid = await repSib.call('POST', '/api/undo', { token: pMid.json().undoToken })
    assert.equal(uMid.status, 200, uMid.body)
    const txtMid = readFileSync(repSib.path, 'utf8')
    assert.ok(txtMid.indexOf('### Repeat') < txtMid.indexOf('Middle target') && txtMid.indexOf('Middle target') < txtMid.lastIndexOf('### Repeat'), txtMid)
  } finally { await repSib.close() }
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

    const refused = await board.call('POST', '/api/undo', { token: pressed.json().undoToken })
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

    const refused = await board.call('POST', '/api/undo', { token: pressed.json().undoToken })
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().ok, false)
    assert.equal(refused.json().note, 'Could not undo: that task is no longer on the board.')
    assert.equal(readFileSync(board.path, 'utf8'), withoutTask)
  } finally { await board.close() }
})

test('a second Undo has nothing to undo', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('e5f6a7b8', 'api-gateway', 'Single undo')}\n\n## second\n${autoStopped('e6f7a8b9', 'second', 'Second tab task')}\n`
  const board = await startBoard(initial)
  try {
    const empty = await board.call('POST', '/api/undo', {})
    assert.equal(empty.status, 409, empty.body)
    assert.equal(empty.json().ok, false)
    assert.equal(empty.json().note, 'Nothing to undo.')

    const before = readFileSync(board.path, 'utf8')
    const row = await board.rowOf('Single undo')
    const done1 = await board.call('POST', '/api/act', { key: row.key, type: 'done', fp: row.fp })
    assert.equal(done1.status, 200)
    const undone1 = await board.call('POST', '/api/undo', { token: done1.json().undoToken })
    assert.equal(undone1.status, 200)
    assert.equal(readFileSync(board.path, 'utf8'), before)

    const second = await board.call('POST', '/api/undo', { token: done1.json().undoToken })
    assert.equal(second.status, 409, second.body)
    assert.equal(second.json().ok, false)
    assert.equal(second.json().note, 'Nothing to undo.')

    // Stale token from tab A must not undo or clear tab B's newer offer.
    const rowA = await board.rowOf('Single undo')
    const rowB = await board.rowOf('Second tab task')
    const actA = await board.call('POST', '/api/act', { key: rowA.key, type: 'archive', fp: rowA.fp })
    const actB = await board.call('POST', '/api/act', { key: rowB.key, type: 'archive', fp: rowB.fp })
    assert.equal(actA.status, 200)
    assert.equal(actB.status, 200)
    const stale = await board.call('POST', '/api/undo', { token: actA.json().undoToken })
    assert.equal(stale.status, 409, stale.body)
    assert.equal(stale.json().note, 'Nothing to undo.')
    const liveB = await board.call('POST', '/api/undo', { token: actB.json().undoToken })
    assert.equal(liveB.status, 200, liveB.body)
    assert.ok(readFileSync(board.path, 'utf8').includes('Second tab task'))
    assert.ok(!readFileSync(board.path, 'utf8').includes('Single undo'))
  } finally { await board.close() }
})

test('Undo after Archive refuses when the archive entry changed since', { timeout: 30_000 }, async () => {
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('f6a7b8c9', 'api-gateway', 'Edited archive')}\n`
  const board = await startBoard(initial)
  try {
    const row = await board.rowOf('Edited archive')
    const pArch = await board.call('POST', '/api/act', { key: row.key, type: 'archive', fp: row.fp })
    assert.equal(pArch.status, 200)
    const afterArchiveProgress = readFileSync(board.path, 'utf8')
    const archFile = join(board.dir, archiveName())
    const editedArchive = readFileSync(archFile, 'utf8').replace('Edited archive', 'Edited in archive')
    writeFileSync(archFile, editedArchive)

    const refused = await board.call('POST', '/api/undo', { token: pArch.json().undoToken })
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().ok, false)
    assert.equal(refused.json().note, 'Could not undo: that task changed since your press.')
    assert.equal(readFileSync(board.path, 'utf8'), afterArchiveProgress)
    assert.equal(readFileSync(archFile, 'utf8'), editedArchive)
  } finally { await board.close() }

  // Regression P1-4: appending a paragraph to the archived entry must also refuse Undo.
  const ext = await startBoard(`# Progress\n\n## api-gateway\n${autoStopped('f7a8b9c0', 'api-gateway', 'Extended archive')}\n`)
  try {
    const row = await ext.rowOf('Extended archive')
    const pExt = await ext.call('POST', '/api/act', { key: row.key, type: 'archive', fp: row.fp })
    assert.equal(pExt.status, 200)
    const archFile = join(ext.dir, archiveName())
    const appendedArchive = `${readFileSync(archFile, 'utf8').trimEnd()}\n\n- [x] Appended note\n`
    writeFileSync(archFile, appendedArchive)
    const refused = await ext.call('POST', '/api/undo', { token: pExt.json().undoToken })
    assert.equal(refused.status, 409, refused.body)
    assert.equal(refused.json().note, 'Could not undo: that task changed since your press.')
    assert.equal(readFileSync(archFile, 'utf8'), appendedArchive)
  } finally { await ext.close() }

  // Regression Greptile #3: two identical tasks archived same day -> editing newest copy refuses 409 and preserves older copy.
  const dupArch = await startBoard(
    `# Progress\n\n## api-gateway\n${autoStopped('d1110001', 'api-gateway', 'Twin task', ['- [x] Twin step', '- [ ] Shared step'])}\n\n${autoStopped('d1110002', 'api-gateway', 'Twin task', ['- [x] Twin step', '- [ ] Shared step'])}\n`,
  )
  try {
    const r1 = await dupArch.rowOf('Twin task')
    assert.equal((await dupArch.call('POST', '/api/act', { key: r1.key, type: 'archive', fp: r1.fp })).status, 200)
    const r2 = await dupArch.rowOf('Twin task')
    const p2 = await dupArch.call('POST', '/api/act', { key: r2.key, type: 'archive', fp: r2.fp })
    assert.equal(p2.status, 200)
    const archFile = join(dupArch.dir, archiveName())
    const archText = readFileSync(archFile, 'utf8')
    const cut = archText.lastIndexOf('Twin step')
    const editedNewest = archText.slice(0, cut) + 'Edited newest' + archText.slice(cut + 'Twin step'.length)
    writeFileSync(archFile, editedNewest)
    const refusedDup = await dupArch.call('POST', '/api/undo', { token: p2.json().undoToken })
    assert.equal(refusedDup.status, 409, refusedDup.body)
    assert.equal(refusedDup.json().note, 'Could not undo: that task changed since your press.')
    assert.ok(readFileSync(archFile, 'utf8').includes('Twin step'), 'older identical archive entry must remain untouched')
  } finally { await dupArch.close() }
})

test('Undo after Confirm done or Archive keeps an unrelated block written meanwhile', { timeout: 30_000 }, async () => {
  const otherBlock = `<!-- auto session=11223344 agent=claude state=working updated=${RECENT} -->\n### Concurrent session\n- [~] Running elsewhere\n<!-- /auto session=11223344 -->\n`
  const initial = `# Progress\n\n## api-gateway\n${autoStopped('a2b3c4d5', 'api-gateway', 'Target task')}\n`
  const board = await startBoard(initial)
  try {
    // Case A: Confirm done then concurrent block added to the same project
    const rowDone = await board.rowOf('Target task')
    const pDone = await board.call('POST', '/api/act', { key: rowDone.key, type: 'done', fp: rowDone.fp })
    assert.equal(pDone.status, 200)
    writeFileSync(board.path, `${readFileSync(board.path, 'utf8').trimEnd()}\n\n${otherBlock}`)
    const undoDone = await board.call('POST', '/api/undo', { token: pDone.json().undoToken })
    assert.equal(undoDone.status, 200, undoDone.body)
    const afterDoneUndo = readFileSync(board.path, 'utf8')
    assert.ok(afterDoneUndo.includes('- [ ] Finish synthetic report'), afterDoneUndo)
    assert.ok(afterDoneUndo.includes('Concurrent session'), afterDoneUndo)

    // Case B: Archive while unrelated section stays untouched and gets updated concurrently
    const rowArchive = await board.rowOf('Target task')
    const pArchive = await board.call('POST', '/api/act', { key: rowArchive.key, type: 'archive', fp: rowArchive.fp })
    assert.equal(pArchive.status, 200)
    writeFileSync(board.path, readFileSync(board.path, 'utf8').replace('Running elsewhere', 'Updated concurrent step'))
    const undoArchive = await board.call('POST', '/api/undo', { token: pArchive.json().undoToken })
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
    const pFirst = await board.call('POST', '/api/act', { key: first.key, type: 'done', fp: first.fp })
    assert.equal(pFirst.status, 200)
    const ticked = await board.call('POST', '/api/act', { key: second.key, type: 'tick', text: 'Tick this later', fp: second.tickFp ?? second.fp, line: second.nextFileLine })
    assert.equal(ticked.status, 200, ticked.body)
    assert.equal(ticked.json().canUndo ?? false, false)

    const afterTickProgress = readFileSync(board.path, 'utf8')
    const undo = await board.call('POST', '/api/undo', { token: pFirst.json().undoToken })
    assert.equal(undo.status, 409, undo.body)
    assert.equal(undo.json().note, 'Nothing to undo.')
    assert.equal(readFileSync(board.path, 'utf8'), afterTickProgress)
  } finally { await board.close() }
})

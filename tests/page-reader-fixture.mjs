import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'

// The fixture clock follows the real one: the page reader keeps receipts and questions for
// three days by the real clock, so a fixed date breaks these tests three days after it.
export const PAGE_NOW = Math.floor(Date.now() / 1000) * 1000
const NOW = PAGE_NOW

// The CLI's entry call is the last `await name();` before a catch in the bundle: the bundle ends with it, and shipped code above
// it can have the same shape (the Codex receiver's reads do). Only that call is replaced, by default with nothing.
export const replaceEntryCall = (script, replacement = '') => {
  const last = [...script.matchAll(/await \w+\(\);(?=\s*\}\s*catch \(error\))/g)].at(-1)
  assert.ok(last, 'the generated entry point must be found in the bundle')
  return script.slice(0, last.index) + replacement + script.slice(last.index + last[0].length)
}

// Only the CLI's entry call is disabled. The reader, API handler and page script are shipped code.
export const pageFixture = async (file = '', inbox = {}, state) => {
  const root = mkdtempSync(join(tmpdir(), 'board-page-regression-'))
  const path = join(root, 'progress.md')
  mkdirSync(join(root, 'progress-inbox'))
  mkdirSync(join(root, 'messages'))
  writeFileSync(path, file)
  utimesSync(path, (NOW - 20000) / 1000, (NOW - 20000) / 1000)
  for (const [name, body] of Object.entries(inbox)) writeFileSync(join(root, 'progress-inbox', name), body)
  if (state) writeFileSync(join(root, 'progress-page-state.json'), JSON.stringify(state))
  const skipped = replaceEntryCall(BOARD_SCRIPT)
  assert.notEqual(skipped, BOARD_SCRIPT)
  const script = join(root, 'reader.mjs')
  writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path, lang: 'en' })}\n${skipped}\nexport { view, pending, serveModel, servePage, boardDocument, startServer, s };\n`)
  const previous = process.argv
  const previousBoard = globalThis.AGENT_BOARD
  const previousProgress = process.env.CLAUDE_PROGRESS_FILE
  let runtime
  try {
    process.argv = [process.execPath, script, '--json']
    delete process.env.CLAUDE_PROGRESS_FILE
    runtime = await import(pathToFileURL(script).href)
  } finally {
    process.argv = previous
    globalThis.AGENT_BOARD = previousBoard
    if (previousProgress === undefined) delete process.env.CLAUDE_PROGRESS_FILE
    else process.env.CLAUDE_PROGRESS_FILE = previousProgress
  }
  let url
  let stopped
  const closed = new Promise(done => { stopped = done })
  const api = async () => {
    if (!url) url = await new Promise((ready, reject) => {
      try {
        runtime.startServer({
          messagesDirectory: join(root, 'messages'), s: runtime.s, port: 0, ping: {},
          view: () => runtime.view(undefined, NOW), pending: () => runtime.pending(),
          act: () => '', tidy: () => '', clean: () => '', sweep: () => {}, sweepMs: 60000,
          paste: () => ({ isAdded: false, note: '' }), failure: () => null,
          onReady: address => { ready(address); return true }, onStop: stopped, idleMs: 0,
        })
      } catch (error) { reject(error) }
    })
    const address = new URL(url)
    const response = await fetch(new URL('/api/board', address), { headers: { 'x-board-token': address.searchParams.get('t') } })
    assert.equal(response.status, 200)
    return (await response.json()).model
  }
  return { root, path, runtime, api, close: async () => {
    if (url) {
      const address = new URL(url)
      await fetch(new URL('/api/close', address), { method: 'POST', headers: { 'x-board-token': address.searchParams.get('t'), 'content-type': 'application/json' }, body: '{}' })
      await closed
      await new Promise(done => setImmediate(done))
    }
    rmSync(root, { recursive: true, force: true })
  } }
}

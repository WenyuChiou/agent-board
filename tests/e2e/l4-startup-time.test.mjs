import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { makeWorld } from './lib/world.mjs'
import { run, runProcess, serve } from './lib/surfaces.mjs'
import { BOARD_OPEN_MS, PAGE_OPEN_MS, SETUP_PREVIEW_MS, STARTUP_RUNS } from './lib/budget.mjs'

const installer = fileURLToPath(new URL('../../scripts/setup-agent.mjs', import.meta.url))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// #768: a simulated user on Windows saw a setup preview take 75 s and the board and page open past
// 5 s. Each run starts from a new empty home, as USER-SIM does, so every run pays the first start of
// whatever the board runs (whoami, icacls, PowerShell). The times are printed so a slow run on a
// runner shows which step it was.
describe('L4 start-up time (#768)', () => {
  test(`setup preview, board and page open within their targets in each of ${STARTUP_RUNS} runs from a new empty home`, async () => {
    const times = { preview: [], board: [], page: [] }
    for (let n = 0; n < STARTUP_RUNS; n++) {
      const world = makeWorld()
      try {
        const began = performance.now()
        const preview = await runProcess(process.execPath, [installer, '--home', world.home, '--data-dir', join(world.root, 'data'), '--progress-file', world.path], { env: world.env, cwd: world.root })
        times.preview.push(Math.round(performance.now() - began))
        assert.equal(preview.status, 0, preview.stderr)

        const boardBegan = performance.now()
        const board = await run(world, ['--no-open'])
        times.board.push(Math.round(performance.now() - boardBegan))
        assert.equal(board.status, 0, board.stderr || board.stdout)

        const pageBegan = performance.now()
        const server = await serve.start(world)
        times.page.push(Math.round(performance.now() - pageBegan))
        await server.stop()
      } finally { await world.close() }
    }
    console.log(`#768 start-up times in ms over ${STARTUP_RUNS} runs: ${JSON.stringify(times)}; medians ${JSON.stringify(Object.fromEntries(Object.entries(times).map(([key, values]) => [key, median(values)])))}`)
    assert.ok(Math.max(...times.preview) <= SETUP_PREVIEW_MS, `setup preview over ${SETUP_PREVIEW_MS} ms: ${times.preview}`)
    assert.ok(Math.max(...times.board) <= BOARD_OPEN_MS, `board over ${BOARD_OPEN_MS} ms: ${times.board}`)
    assert.ok(Math.max(...times.page) <= PAGE_OPEN_MS, `page over ${PAGE_OPEN_MS} ms: ${times.page}`)
  })
})

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pageFixture, PAGE_NOW } from './page-reader-fixture.mjs'

test('a page poll that catches its shared state mid-write keeps processed inbox files excluded', async () => {
  const name = `codex-turn-${PAGE_NOW}-1.json`
  const state = { version: 1, inboxDone: { [name]: `synthetic:${PAGE_NOW}` }, store: 0, pruned: {} }
  const fixture = await pageFixture('', { [name]: JSON.stringify({ session_id: 'synthetic', cwd: '/work/demo', last_assistant_message: 'Publish the synthetic build?' }) }, state)
  try {
    assert.equal((await fixture.api()).counts.waiting, 0)
    writeFileSync(join(fixture.root, 'progress-page-state.json'), '{"version":1,')
    const model = await fixture.api()
    assert.equal(model.counts.waiting, 0)
    assert.deepEqual(model.turns, [])
  } finally { await fixture.close() }
})

test('a page poll that catches its shared state mid-write keeps its measured storage notices', async () => {
  const state = { version: 1, inboxDone: {}, store: 2 * 1024 * 1024, pruned: { [new Date(PAGE_NOW).toISOString().slice(0, 10)]: { agent: 2, mirror: 3 } } }
  const fixture = await pageFixture('', {}, state)
  try {
    const before = await fixture.api()
    assert.ok(before.warning && before.pruned)
    writeFileSync(join(fixture.root, 'progress-page-state.json'), '{"version":1,')
    const after = await fixture.api()
    assert.equal(after.warning, before.warning)
    assert.equal(after.pruned, before.pruned)
    writeFileSync(join(fixture.root, 'progress-page-state.json'), JSON.stringify({ ...state, store: 0, pruned: {} }))
    const restored = await fixture.api()
    assert.equal(restored.warning, undefined)
    assert.equal(restored.pruned, undefined)
  } finally { await fixture.close() }
})

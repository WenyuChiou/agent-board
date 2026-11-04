import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { BOARD_SCRIPT } from '../hooks/board-script.ts'
import { pageFixture as fixture } from './page-reader-fixture.mjs'
import { pageDom } from './e2e/lib/surfaces.mjs'

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { liveBoardArgv, liveBoardPage } = await import('../hooks/live-page.ts')
const { EN } = await import('../hooks/strings-en.ts')
const NOW = Date.parse('2026-11-04T12:00:00Z')
const NAME = 'codex-turn-1793793600000-1.json'
const turn = answer => JSON.stringify({ session_id: 'synthetic-turn', cwd: '/work/demo', prompt: 'Private prompt contents /home/demo/private', last_assistant_message: answer })

test('interactive live opens request a browser and keep the printed link fallback', () => {
  assert.equal(liveBoardArgv('/synthetic/agent-board.mjs', 'en', true).includes('--no-open'), false)
  assert.equal(liveBoardArgv('/synthetic/agent-board.mjs', 'en', false).includes('--no-open'), true)
  const url = 'http://127.0.0.1:23456/?t=synthetic'
  assert.deepEqual(liveBoardPage(`${EN.serveAt(url)}\n`, EN), { url, isKept: false })
})

test('the production page API and LAN model omit private non-question inbox text', async () => {
  const secret = `sk-${'a'.repeat(40)}`
  const f = await fixture('', { [NAME]: turn(`Private reply contents /home/demo/private ${secret}.`) })
  try {
    const view = f.runtime.view(undefined, NOW)
    for (const model of [await f.api(), f.runtime.serveModel(view, f.runtime.pending(), EN, new Set(), true)]) {
      assert.deepEqual(model.turns.map(one => [one.agent, one.project]), [['codex', 'demo']])
      assert.doesNotMatch(JSON.stringify(model), /Private prompt|Private reply|\/home\/demo|sk-aaaa/)
    }
  } finally { await f.close() }
})

test('the production page reader excludes processed inbox files from its API counts', async () => {
  const f = await fixture('', { [NAME]: turn('Ship the synthetic patch?') }, { version: 1, at: NOW, inboxDone: { [NAME]: `synthetic:${NOW}` }, store: 0, pruned: {} })
  try {
    const model = await f.api()
    assert.equal(model.counts.waiting, 0)
    assert.deepEqual(model.turns, [])
    assert.deepEqual(f.runtime.pending(), [])
  } finally { await f.close() }
})

test('the production page API and rendered page retain cut-off block notices', async () => {
  const f = await fixture('## demo\n<!-- auto session=abcdef12 agent=codex state=working updated=2026-10-01T00:00:00Z -->\n### Cut-off task\n- [ ] Continue\n')
  try {
    const model = await f.api()
    assert.ok(model.health?.some(line => /cut off when its session crashed/.test(line)), JSON.stringify(model))
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    assert.match(dom.node('board').readText, /Cut-off task/)
    for (const line of model.health) assert.ok(dom.node('board').readText.includes(line))
  } finally { await f.close() }
})

test('the production page API renders the measured store warning and cleared counts', async () => {
  const f = await fixture('', {}, { version: 1, at: NOW, inboxDone: {}, store: 2 * 1024 * 1024, pruned: { '2026-11-04': { agent: 2, mirror: 3 } } })
  try {
    const model = await f.api()
    assert.equal(model.warning, EN.boardLarge)
    assert.ok(model.pruned?.includes(EN.prunedAgents(2)), JSON.stringify(model))
    assert.ok(model.pruned?.includes(EN.prunedSessions(3)), JSON.stringify(model))
    const dom = await pageDom(f.runtime.servePage(EN, 'synthetic'), model)
    assert.ok(dom.node('board').readText.includes(model.warning))
    assert.ok(dom.node('board').readText.includes(model.pruned))
  } finally { await f.close() }
})

test('JSON and print clip an untrusted field at six hundred characters', async () => {
  const title = 'Long synthetic field '.repeat(60)
  const f = await fixture(`## demo\n### ${title}\n- [ ] Continue\n`)
  try {
    writeFileSync(join(f.root, 'cli.mjs'), `globalThis.AGENT_BOARD = ${JSON.stringify({ path: f.path, lang: 'en' })}\n${BOARD_SCRIPT}`)
    for (const flag of ['--json', '--print']) {
      const ran = spawnSync(process.execPath, [join(f.root, 'cli.mjs'), flag], { encoding: 'utf8', timeout: 10000 })
      assert.equal(ran.status, 0, ran.stderr)
      assert.ok(ran.stdout.includes('Long synthetic field'))
      assert.ok(!ran.stdout.includes(title.slice(0, 601)))
      if (flag === '--json') assert.equal(JSON.parse(ran.stdout).waiting[0].title, title.slice(0, 600).replace(/\s*\S*$/, ''))
    }
  } finally { await f.close() }
})


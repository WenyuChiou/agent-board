import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { BOARD_BUDGETS as budget } from './fixtures/board-budgets.mjs'

// The pure plugin sources use extensionless imports. Resolve only their relative imports,
// as board.test.mjs does, without changing the production modules or loading an AI host.
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const modules = {}
try {
  modules.view = await import('../hooks/view.ts')
  modules.parse = await import('../hooks/parse.ts')
  modules.questions = await import('../hooks/questions.ts')
} finally { loader.deregister() }
const { buildView } = modules.view
const { parseProgress } = modules.parse
const { emptyQuestions, observeQuestions, parseQuestions } = modules.questions

const NOW = Date.parse('2026-10-20T12:00:00Z')
const agents = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'opencode', 'hermes']
const block = index => {
  const id = index.toString(16).padStart(8, '0')
  const state = index < budget.liveBlocks ? 'working' : 'ended'
  return `<!-- auto session=${id} agent=${agents[index % agents.length]} state=${state} updated=${new Date(NOW).toISOString()} -->\n### Synthetic task ${index}\n> Context: synthetic budget fixture\n- [x] Prepare fixture\n- [?] Review synthetic result ${index}, OK?\n- [ ] Record outcome\n<!-- /auto session=${id} -->\n`
}

test('building the view of a 300-block file takes under 50 milliseconds', t => {
  const file = `## Synthetic budget\n${Array.from({ length: budget.blocks }, (_, index) => block(index)).join('\n')}`
  const projects = parseProgress(file)
  const history = parseProgress(`## Synthetic budget\n${Array.from({ length: budget.ledgerRecords }, (_, index) => block(index)).join('\n')}`)
  const observed = observeQuestions(emptyQuestions(), history, null, [], NOW, true)
  // Keep the real block questions plus resolved historical records: no hand-built invalid ids.
  const ledger = { ...observed.ledger, records: observed.ledger.records.map((record, index) => index < budget.blocks ? record : { ...record, isUnresolved: false, isWaiting: false, isPresent: false, resolvedAt: NOW }) }
  assert.ok(parseQuestions(JSON.stringify(ledger)))
  const tasks = projects.flatMap(project => project.tasks)
  assert.equal(tasks.length, budget.blocks)
  assert.equal(tasks.filter(task => task.auto?.state === 'working').length, budget.liveBlocks)
  assert.equal(ledger.records.length, budget.ledgerRecords)
  const before = JSON.stringify({ projects, ledger })
  const unmatchedProofs = { retired: ['0'.repeat(64)], consumed: [] }
  assert.deepEqual(
    observeQuestions(ledger, projects, null, [], NOW),
    observeQuestions(ledger, projects, null, [], NOW, false, 'preview', unmatchedProofs),
    'an empty retirement list and a nonmatching proof preserve the same ledger and identities',
  )
  const run = () => buildView(projects, [], null, NOW, 0, {}, undefined, [], {}, ledger)
  for (let index = 0; index < budget.warmupRuns; index += 1) run()
  const samples = []
  let view
  for (let index = 0; index < budget.measuredRuns; index += 1) {
    const start = performance.now()
    view = run()
    samples.push(performance.now() - start)
  }
  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  t.diagnostic(`buildView milliseconds: ${samples.map(value => value.toFixed(3)).join(', ')}; median=${median.toFixed(3)}; budget=${budget.buildViewMs}`)
  assert.equal(view.waiting.length, budget.liveBlocks)
  assert.equal(view.stopped.length, budget.blocks - budget.liveBlocks)
  assert.equal(JSON.stringify({ projects, ledger }), before, 'building the view leaves its inputs intact')
  assert.ok(median < budget.buildViewMs, `buildView median ${median.toFixed(3)} ms must be below ${budget.buildViewMs} ms`)
})

test('view question indexes preserve the first record when a direct caller repeats an id', () => {
  const projects = parseProgress(`## Synthetic budget\n${block(0)}`)
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW, true).ledger
  const first = ledger.records[0]
  // Disk parsing rejects duplicate ids. A direct caller still gets the former first-match
  // behavior, rather than a later unrelated record suppressing the real question.
  const repeated = { ...ledger, records: [...ledger.records, { ...first, scope: 'unrelated synthetic scope', isPresent: false, isWaiting: false, isUnresolved: false }] }
  assert.deepEqual(
    buildView(projects, [], null, NOW, 0, {}, undefined, [], {}, repeated),
    buildView(projects, [], null, NOW, 0, {}, undefined, [], {}, ledger),
  )
})

test('indexed observations keep duplicate question identities across repeated observations', () => {
  const projects = parseProgress(`## Synthetic budget\n${block(0).replace('- [ ] Record outcome', '- [?] Review synthetic result 0, OK?')}\n${block(1)}`)
  const first = observeQuestions(emptyQuestions(), projects, null, [], NOW, true)
  const again = observeQuestions(first.ledger, projects, null, [], NOW + 1, true)
  assert.equal(first.ledger.records.length, 3)
  assert.equal(new Set(first.ledger.records.map(record => record.id)).size, 3)
  assert.deepEqual(again, first)
})

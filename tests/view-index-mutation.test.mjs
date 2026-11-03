// Lookup indexes in the observe/view path stay correct when the underlying data
// changes (#192). The indexes are built fresh on every observeQuestions call and
// every record pushed during a call is indexed, so a later call — or a later
// question group in the same call — never reads a stale list. Synthetic data only:
// no network, no clock or platform input, no model call anywhere in this file.
//
// These tests guard the index change, not the budget: timings live in
// tests/performance-budgets.test.mjs and are not asserted here.

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// The board modules use extensionless imports; resolve only those local paths, as
// tests/messaging.test.mjs does.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return next(`${specifier}.ts`, context)
  }
} })

const { parseProgress } = await import('../hooks/parse.ts')
const { buildView } = await import('../hooks/view.ts')
const { emptyQuestions, observeQuestions } = await import('../hooks/questions.ts')
const { ZH_TW } = await import('../hooks/i18n.ts')

const NOW = Date.parse('2026-10-25T12:00:00Z')
const file = (steps, project = 'demo', session = 'a1b2c3d4') =>
  `## ${project}\n<!-- auto session=${session} agent=codex state=waiting updated=${new Date(NOW).toISOString()} dir=${encodeURIComponent(`/work/${project}`)} -->\n### Ship\n${steps}\n<!-- /auto session=${session} -->\n`
const observe = (ledger, text) => observeQuestions(ledger, parseProgress(text), null, [], NOW, true)
const viewOf = (ledger, text) => buildView(parseProgress(text), [], null, NOW, 0, {}, ZH_TW, [], {}, ledger, { retired: [], consumed: [] }, [], new Set())

test('a later observe call sees ledger mutations and board edits, not a stale index', () => {
  const first = file('- [?] First question?\n- [?] Second question?')
  const observed = observe(emptyQuestions(), first)
  assert.equal(observed.ledger.records.length, 2)
  assert.ok(observed.ledger.records.every(record => record.isPresent && record.isWaiting && record.isUnresolved))

  // Between calls the first question is resolved and the second is reworded.
  const ledger = observed.ledger
  const firstRecord = ledger.records.find(record => record.words === 'First question?')
  assert.ok(firstRecord !== undefined)
  firstRecord.isUnresolved = false
  firstRecord.isWaiting = false
  firstRecord.resolvedAt = NOW
  const second = file('- [?] First question?\n- [?] Second question, revised?')
  const again = observe(ledger, second)
  // The resolved record stays resolved, the reworded ask is a new record, and the
  // old wording no longer waits: nothing is resurrected from a stale list.
  assert.equal(again.ledger.records.length, 3)
  assert.equal(again.ledger.records.find(record => record.words === 'First question?')?.isUnresolved, false)
  assert.equal(again.ledger.records.find(record => record.words === 'Second question?')?.isWaiting, false)
  const revised = again.ledger.records.find(record => record.words === 'Second question, revised?')
  assert.ok(revised !== undefined && revised.isWaiting && revised.isUnresolved)
  // The preview view re-observes unsettled, so an absent-but-unresolved record may
  // still show; what matters is the revised ask shows under its new record's id.
  const shown = viewOf(again.ledger, second).waiting
  assert.ok(shown.some(item => item.text === 'Second question, revised?' && item.questionId === revised.id))
})

test('a record pushed for one group is visible to a later group in the same call', () => {
  const text = file('- [?] Alpha ask?\n- [?] Beta ask?')
  const projects = parseProgress(text)
  const steps = projects.flatMap(project => project.tasks.flatMap(task => task.steps))
  assert.equal(steps.length, 2)
  // Two asks from one owner prefix, different full producers: the second ask's
  // owner scan must find the record the first ask just created and retire it,
  // which only happens when pushes join the per-call indexes.
  steps[0].questionToken = 'ownerX:11111111'
  steps[1].questionToken = 'ownerX:22222222'
  const observed = observeQuestions(emptyQuestions(), projects, null, [], NOW, true)
  assert.equal(observed.ledger.records.length, 2)
  const alpha = observed.ledger.records.find(record => record.words === 'Alpha ask?')
  const beta = observed.ledger.records.find(record => record.words === 'Beta ask?')
  assert.ok(alpha !== undefined && beta !== undefined)
  assert.equal(alpha.isPresent, false)
  assert.equal(alpha.isWaiting, false)
  assert.equal(alpha.isUnresolved, false)
  assert.equal(beta.isPresent, true)
  assert.equal(beta.isWaiting, true)
})

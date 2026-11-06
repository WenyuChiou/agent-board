import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Exercise the source modules, not the generated board bundle.
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

let source
try {
  source = await Promise.all([
    import('../hooks/tidy.ts'),
    import('../hooks/parse.ts'),
    import('../hooks/strings-en.ts'),
  ])
} finally { loader.deregister() }

const [{ previewTidy, currentTidyCandidate }, { parseProgress }, { EN }] = source
const now = Date.parse('2026-11-06T12:00:00Z')
const block = (session, agent, state, updated, body = `### Synthetic ${session}\n- [x] Finished step`) =>
  `<!-- auto session=${session} agent=${agent} state=${state} updated=${updated} -->\n${body}\n<!-- /auto session=${session} -->\n`

test('tidy skips a hand-kept heading with null auto inside a closed block', () => {
  // The heading-less owner consumes the marker; the only explicit heading is manual.
  const text = '## Synthetic project\n' + block('manual01', 'codex', 'ended', '2026-11-01T12:00:00Z', '- [x] Owner step\n### Hand-kept task\n- [ ] Keep this')
  const tasks = parseProgress(text)[0].tasks
  assert.equal(tasks.length, 2)
  assert.equal(tasks[1].auto, null)
  assert.deepEqual(previewTidy(text, { kind: 'stopped' }, now, EN).candidates, [])
})

test('tidy preserves owner eligibility and agent and age filters after narrowing auto', () => {
  const text = '## Synthetic project\n'
    + block('ended001', 'codex', 'ended', '2026-11-01T12:00:00Z')
    + block('done0001', 'claude', 'done', '2026-11-06T11:00:00Z')
    + block('stale001', 'codex', 'working', '2026-11-01T12:00:00Z')
    + block('live0001', 'codex', 'working', '2026-11-06T11:59:00Z')
    + block('wait0001', 'codex', 'waiting', '2026-11-06T11:59:00Z')
  const sessions = selector => previewTidy(text, selector, now, EN).candidates.map(one => one.ref.session)
  assert.deepEqual(sessions({ kind: 'stopped' }), ['ended001', 'done0001', 'stale001'])
  assert.deepEqual(sessions({ kind: 'agent', value: 'codex' }), ['ended001', 'stale001'])
  assert.deepEqual(sessions({ kind: 'older', days: 3 }), ['ended001', 'stale001'])
  const preview = previewTidy(text, { kind: 'stopped' }, now, EN)
  const candidate = preview.candidates[0]
  assert.deepEqual(candidate.ref, { project: 'Synthetic project', title: 'Synthetic ended001', line: 2, session: 'ended001' })
  assert.equal(candidate.asks, false)
  assert.deepEqual(currentTidyCandidate(text, preview, candidate, EN), candidate)
  assert.equal(currentTidyCandidate(text.replace('state=ended', 'state=working').replace('updated=2026-11-01T12:00:00Z', 'updated=2026-11-06T11:59:00Z'), preview, candidate, EN), undefined)
})

import { expect, test } from 'claude-code/testing'
import { renderAutoBlock } from '../hooks/blocks'
import { boardText } from '../hooks/board'
import { dashboardHtml } from '../hooks/dashboard'
import { applyDigest, parseDigest } from '../hooks/digest'
import { applyTaskCreate, applyTaskUpdate, completedSince, emptyMirror, fromTaskList, markAnswered, questionToken, resumeNote, stateOf } from '../hooks/mirror'
import { parseProgress } from '../hooks/parse'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'

const NOW = Date.parse('2026-10-19T12:00:00Z')

test('a confirmed task handoff removes only the transferred owner responsibility and survives a passive list refresh', () => {
  let before = applyTaskCreate(emptyMirror('source-a', 'demo', NOW), { subject: 'Finish export' }, '1', NOW)
  before = { ...applyTaskCreate(before, { subject: 'Review documentation' }, '2', NOW), title: 'Source work' }
  const after = applyTaskUpdate(before, { taskId: '1', metadata: { handoffTo: 'Export session' } }, NOW)
  expect(after.tasks[0]).toMatchObject({ status: 'completed', handoffTo: 'Export session', waiting: null })
  expect(completedSince(before, after)).toEqual([])
  expect(applyTaskUpdate(before, { taskId: '1', status: 'completed', metadata: { handoffTo: 'Export session', waiting: 'you' } }, NOW).tasks[0]).toMatchObject({ status: 'completed', handoffTo: 'Export session', waiting: null })
  expect(stateOf(after, false)).toBe('waiting')
  expect(resumeNote(after, STRINGS.en)).not.toContain('Finish export')
  expect(resumeNote(after, STRINGS.en)).toContain('Review documentation')
  const listed = fromTaskList(after, before.tasks.map(task => ({ id: task.id, subject: task.subject, status: task.status, blockedBy: [] })), NOW + 1)
  expect(listed.tasks[0]?.handoffTo).toBe('Export session')
  expect(listed.tasks[0]?.status).toBe('completed')
  const reclaimed = applyTaskUpdate(listed, { taskId: '1', status: 'in_progress' }, NOW + 2)
  expect(reclaimed.tasks[0]?.handoffTo).toBeUndefined()
  expect(reclaimed.tasks[0]?.status).toBe('in_progress')
  const renamed = fromTaskList(after, [{ id: '1', subject: 'New work', status: 'pending', blockedBy: [] }], NOW + 3)
  expect(renamed.tasks[0]?.handoffTo).toBeUndefined()
})

for (const s of Object.values(STRINGS)) test(`mixed handoff and ask metadata keeps producer revisions through reload and explicit reclamation in ${s.lang}`, () => {
  let before = applyTaskCreate(emptyMirror('source-a', 'demo', NOW), { subject: 'Finish export', metadata: { waiting: 'you', why: 'Proceed?', ask: 'confirm' } }, '1', NOW)
  before = applyTaskCreate(before, { subject: 'Review docs', metadata: { waiting: 'you', why: 'Review now?' } }, '2', NOW)
  before = markAnswered(before, ['1', '2'])
  const revision = before.tasks[0]!.questionRevision
  const sequence = before.questionSequence
  const token = questionToken(before.tasks[0]!)
  const after = applyTaskUpdate(before, { taskId: '1', status: 'pending', metadata: { waiting: 'you', why: 'Proceed?', handoffTo: 'Export session' } }, NOW + 1)
  expect(after.tasks[0]).toMatchObject({ status: 'completed', waiting: null, why: null, ask: null, handoffTo: 'Export session', questionRevision: revision })
  expect(after.questionSequence).toBe(sequence)
  expect(after.answered).toEqual(before.answered)
  expect(questionToken(after.tasks[1]!)).toBe(questionToken(before.tasks[1]!))
  const reloaded = fromTaskList(after, before.tasks.map(task => ({ id: task.id, subject: task.subject, status: 'pending' as const, blockedBy: [] })), NOW + 2)
  expect(reloaded.tasks[0]).toMatchObject({ status: 'completed', handoffTo: 'Export session', questionRevision: revision, waiting: null, ask: null })
  expect(reloaded.questionSequence).toBe(sequence)
  const file = '# Progress\n## demo\n' + renderAutoBlock(reloaded, s).join('\n')
  expect(file).toContain(`- [-] Finish export — ${s.transferredTo('Export session')}\n<!-- question=${token} -->`)
  const parsed = parseProgress(file)[0]!.tasks[0]!.steps[0]!
  expect(parsed.status).toBe('cancelled')
  expect(parsed.questionToken).toBe(token)
  expect(parsed.text).not.toContain(token)
  const reclaimed = applyTaskUpdate(reloaded, { taskId: '1', status: 'in_progress' }, NOW + 3)
  expect(reclaimed.tasks[0]?.handoffTo).toBeUndefined()
  expect(reclaimed.tasks[0]?.questionRevision).toBe(revision)
  const askedAgain = applyTaskUpdate(reclaimed, { taskId: '1', metadata: { waiting: 'you', why: 'Proceed?' } }, NOW + 4)
  expect(BigInt(askedAgain.tasks[0]!.questionRevision!)).toBe(BigInt(sequence!) + 1n)
  expect(askedAgain.questionSequence).toBe(askedAgain.tasks[0]!.questionRevision)
  expect(askedAgain.tasks[1]?.questionRevision).toBe(before.tasks[1]?.questionRevision)
  expect(askedAgain.answered?.['1']).toBeUndefined()
  expect(askedAgain.answered?.['2']).toBe(before.answered?.['2'])
})

test('turn digests retain an explicit handoff as a cancelled pointer without treating proposals as transfers', () => {
  const digest = parseDigest('TITLE: Export fixes\nDONE: Fixed issue 10\nNEXT: Finish issue 11\nASK: -\nHANDOFF: Export session')
  expect(digest?.handoffTo).toBe('Export session')
  const mirror = applyDigest(emptyMirror('source-a', 'demo', NOW), digest!, NOW)
  expect(stateOf(mirror, false)).toBe('done')
  expect(completedSince(emptyMirror('source-a', 'demo', NOW), mirror).map(task => task.subject)).toEqual(['Fixed issue 10'])
  expect(resumeNote(mirror, STRINGS.en)).toBeNull()
  const proposal = parseDigest('TITLE: Export fixes\nNEXT: Ask Export session to help\nASK: -\nHANDOFF: -')
  expect(stateOf(applyDigest(mirror, proposal!, NOW + 1), false)).toBe('waiting')
  // Older five-field summaries remain valid and keep their next step open.
  expect(parseDigest('NEXT: Continue here\nASK: -')?.handoffTo).toBeUndefined()
  // A recipient alone cannot retire unscoped prior tasks.
  expect(parseDigest('HANDOFF: Export session')).toBeNull()
})

for (const s of Object.values(STRINGS)) test(`handoff pointers preserve the recipient and count work only at its active owner in ${s.lang}`, () => {
  for (const agent of ['claude', 'codex', 'antigravity', 'grok', 'opencode', 'openclaw', 'deepseek', 'cursor', 'gemini', 'muse', 'hermes', 'dot', 'custom-agent']) {
    const base = { ...emptyMirror('source-a', 'demo', NOW, '', agent), title: 'Source work' }
    const handed = applyTaskUpdate(applyTaskCreate(base, { subject: 'Finish export' }, '1', NOW), { taskId: '1', metadata: { handoffTo: 'Export session' } }, NOW)
    const source = { ...handed, state: stateOf(handed, false) }
    const target = { ...applyTaskCreate(emptyMirror('target-b', 'demo', NOW, '', agent), { subject: 'Finish export' }, '1', NOW), title: 'Export session', state: 'working' as const }
    const file = '# Progress\n## demo\n' + renderAutoBlock(source, s).join('\n') + '\n' + renderAutoBlock(target, s).join('\n')
    expect(file).toContain(`- [-] Finish export — ${s.transferredTo('Export session')}`)
    const remote = buildView(parseProgress(file), [], null, NOW, 0, {}, s)
    expect(remote.overview.active).toBe(1)
    expect(remote.active.map(row => row.title)).toEqual(['Export session'])
    // Activity-only hooks can leave the source waiting. Cancelled work is still
    // closed; it must not return to the active count without a new open step.
    const waiting = file.replace('state=done', 'state=waiting')
    expect(buildView(parseProgress(waiting), [], null, NOW, 0, {}, s).overview.active).toBe(1)
    const own = buildView(parseProgress(file), [], source, NOW, 0, {}, s)
    expect(own.current?.state).toBe('done')
    expect(own.current?.done).toBe(0)
    expect(own.current?.total).toBe(0)
    expect(own.current?.steps[0]).toMatchObject({ status: 'cancelled', note: s.transferredTo('Export session'), isCurrent: false })
    for (const output of [boardText(remote, [], s), dashboardHtml(remote, s, '/synthetic/progress.md', 'test'), JSON.stringify(serveModel(remote, [], s))]) {
      expect(output).toContain('Export session')
    }
    expect(s.digestPrompt('', '', '', '', '', '')).toContain('HANDOFF:')
  }
})

test('cancelled-only work is closed without counting a finished step and an empty task stays open', () => {
  const file = '## Demo\n### Transferred\n- [-] Export — Handed to Export session\n### Empty\n'
  const view = buildView(parseProgress(file), [], null, NOW, 0, {}, STRINGS.en)
  expect(view.active.map(row => row.title)).not.toContain('Transferred')
  expect(view.active.map(row => row.title)).toContain('Empty')
})

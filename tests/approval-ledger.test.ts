import { test, expect } from './kit'
import { renderAutoBlock } from '../hooks/blocks'
import { boardConfirmedReport, codexEvent, codexReport, putCodexBlock, questionSteps, validateCodexReport } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import { clearApproval, closeApproval, markApproval, retainApproval } from '../hooks/digest'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions, resolveQuestion } from '../hooks/questions'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'
import type { ProgressMirror } from '../types'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const session = 'synthetic-codex-session'
const owner = 'a'.repeat(64)
const words = STRINGS.en
const projectsOf = (mirror: ProgressMirror) => parseProgress(`## demo\n${renderAutoBlock(mirror, words).join('\n')}\n`)
const codexProjects = (report: CodexReport) => parseProgress(putCodexBlock('', report, owner))
const event = (previous: CodexReport | null, name: string, turn: string, extra: Record<string, unknown> = {}, now = NOW) =>
  codexEvent(previous, { session_id: session, hook_event_name: name, turn_id: turn, ...extra }, new Date(now).toISOString(), words)

test('a tool approval closed after the ledger saw it leaves Needs you', () => {
  const task = applyTaskCreate(emptyMirror('a1b2c3d4-claude-session', 'demo', NOW), { subject: 'Real task' }, '1', NOW)
  const waiting = markApproval(task, 'Approve the tool?')
  const open = observeQuestions(emptyQuestions(), projectsOf(waiting), waiting, [], NOW, true).ledger
  expect(open.records.filter(record => record.isUnresolved)).toHaveLength(1)
  expect(buildView(projectsOf(waiting), [], waiting, NOW, 0, {}, words, [], {}, open).waiting).toHaveLength(1)

  const missing = clearApproval(waiting)
  const retained = observeQuestions(open, projectsOf(missing), missing, [], NOW + 1, true).ledger
  expect(buildView(projectsOf(missing), [], missing, NOW + 1, 0, {}, words, [], {}, retained).waiting).toHaveLength(1)

  const finished = closeApproval(waiting)
  expect(finished.tasks.find(one => one.id === 'approval')).toMatchObject({ status: 'completed', waiting: null, why: null })
  const closed = observeQuestions(open, projectsOf(finished), finished, [], NOW + 1).ledger
  expect(closed.records.filter(record => record.isUnresolved)).toEqual([])
  const cleared = clearApproval(finished)
  const settled = observeQuestions(closed, projectsOf(cleared), cleared, [], NOW + 2, true).ledger
  expect(buildView(projectsOf(cleared), [], cleared, NOW + 2, 0, {}, words, [], {}, settled).waiting).toEqual([])
  expect(closeApproval(cleared)).toBe(cleared)
})

test('a Codex approval settles immediately while a chat reply leaves its question open until the next report', () => {
  for (const kind of ['PermissionRequest', 'Stop']) {
    const started = event(null, 'UserPromptSubmit', 'turn-1')
    const waiting = event(started, kind, 'turn-1', kind === 'Stop' ? { question: 'Which folder?' } : {})
    const openProjects = codexProjects(waiting)
    const open = observeQuestions(emptyQuestions(), openProjects, null, [], NOW, true).ledger
    expect(open.records.filter(record => record.isUnresolved)).toHaveLength(1)
    expect(buildView(openProjects, [], null, NOW, 0, {}, words, [], {}, open).waiting).toHaveLength(1)

    const replied = event(waiting, 'UserPromptSubmit', 'turn-2', {}, NOW + 1)
    const repliedProjects = codexProjects(replied)
    const afterReply = observeQuestions(open, repliedProjects, null, [], NOW + 1, true).ledger
    expect(afterReply.records.filter(record => record.isUnresolved).map(record => record.id))
      .toEqual(kind === 'Stop' ? [open.records[0]!.id] : [])
    expect(buildView(repliedProjects, [], null, NOW + 1, 0, {}, words, [], {}, afterReply).waiting).toEqual([])
    if (kind === 'Stop') {
      const finished = event(replied, 'Stop', 'turn-2', { has_response: true }, NOW + 2)
      const closed = observeQuestions(afterReply, codexProjects(finished), null, [], NOW + 2, true).ledger
      expect(closed.records.filter(record => record.isUnresolved)).toEqual([])
    }
  }
})

test('a Codex session end closes an approval but leaves its last question waiting', () => {
  const started = event(null, 'UserPromptSubmit', 'turn-1')
  const approval = event(started, 'PermissionRequest', 'turn-1')
  const endedApproval = event(approval, 'SessionEnd', 'turn-1')
  expect(endedApproval.steps[endedApproval.approval!]).toBe(`- [x] ${words.codexApprovalStep}`)
  const question = event(started, 'Stop', 'turn-1', { question: 'Which folder?' })
  const endedQuestion = event(question, 'SessionEnd', 'turn-1')
  expect(endedQuestion.steps[endedQuestion.asked!]).toBe('- [?] Which folder?')
})

test('Codex reports carry both owned closures independently of the forty user step limit', () => {
  const started = event(null, 'UserPromptSubmit', 'turn-1')
  const approval = event(started, 'PermissionRequest', 'turn-1')
  const question = event(approval, 'Stop', 'turn-1', { question: 'Which folder?' })
  const first = observeQuestions(emptyQuestions(), codexProjects(approval), null, [], NOW, true).ledger
  const open = observeQuestions(first, codexProjects(question), null, [], NOW + 1, true).ledger
  for (const count of [38, 39, 40]) {
    const steps = Array.from({ length: count }, (_, index) => `- [ ] Task ${index}`)
    let report = codexReport(question, session, { title: 'Task', state: 'working', steps }, new Date(NOW).toISOString(), words)
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(report.steps).toHaveLength(count + 2)
      expect(report.steps.slice(0, count)).toEqual(steps)
      expect(report.steps[report.approval!]).toBe(`- [x] ${words.codexApprovalStep}`)
      expect(report.steps[report.asked!]).toBe('- [x] Which folder?')
      expect(report.approvalRevision).toBe(approval.approvalRevision)
      expect(report.askedRevision).toBe(question.askedRevision)
      expect(putCodexBlock('', report, owner)).not.toContain('native=codex')
      const projects = codexProjects(report)
      const closed = observeQuestions(open, projects, null, [], NOW + 2, true).ledger
      expect(closed.records.filter(record => record.isUnresolved)).toEqual([])
      expect(buildView(projects, [], null, NOW + 2, 0, {}, words, [], {}, closed).waiting).toEqual([])
      report = codexReport(JSON.parse(JSON.stringify(report)), session, { title: 'Task', state: 'working', steps }, new Date(NOW).toISOString(), words)
    }
  }
})

test('a delayed completion of the old Codex approval cannot hide its replacement', () => {
  const first = event(event(null, 'UserPromptSubmit', 'turn-1'), 'PermissionRequest', 'turn-1')
  const open = observeQuestions(emptyQuestions(), codexProjects(first), null, [], NOW, true).ledger
  const oldId = open.records[0]!.id
  const closed = codexReport(first, session, { title: 'Task', state: 'working', steps: ['- [~] Work'] }, new Date(NOW).toISOString(), words)
  const second = event(JSON.parse(JSON.stringify(closed)), 'PermissionRequest', 'turn-1')
  expect(second.approvalRevision).toBe(String(BigInt(first.approvalRevision!) + 1n))
  const resumed = event(second, 'SessionStart', 'turn-1')
  expect(resumed.steps).toEqual(second.steps)
  expect(resumed.approvalRevision).toBe(second.approvalRevision)
  const projects = codexProjects(resumed)
  const newer = observeQuestions(open, projects, null, [], NOW + 1, true).ledger
  expect(newer.records.find(record => record.isUnresolved)?.id).not.toBe(oldId)
  const delayed = resolveQuestion(newer, oldId, NOW + 2)
  expect(delayed.records.filter(record => record.isUnresolved)).toHaveLength(1)
  expect(buildView(projects, [], null, NOW + 2, 0, {}, words, [], {}, delayed).waiting).toHaveLength(1)
})

test('Codex approval and question producers stay independent and legacy rows remain conservative', () => {
  const approval = event(event(null, 'UserPromptSubmit', 'turn-1'), 'PermissionRequest', 'turn-1')
  const pending = event(approval, 'Stop', 'turn-1', { question: 'Which folder?' })
  const open = observeQuestions(emptyQuestions(), codexProjects(pending), null, [], NOW, true).ledger
  // A synthetic snapshot isolates identity from the separately owned host-question lifecycle.
  const replacement = { ...pending, approvalRevision: String(BigInt(approval.approvalRevision!) + 1n),
    steps: pending.steps.map((step, index) => index === pending.approval ? `- [?] ${words.codexApprovalStep}` : step) }
  const projects = codexProjects(replacement)
  const retained = observeQuestions(open, projects, null, [], NOW + 1, true).ledger
  expect(retained.records.filter(record => record.isUnresolved)).toHaveLength(2)
  expect(buildView(projects, [], null, NOW + 1, 0, {}, words, [], {}, retained).waiting).toHaveLength(2)
  const tokens = projects[0]!.tasks[0]!.steps.flatMap(step => step.questionToken ? [step.questionToken] : [])
  expect(new Set(tokens.map(token => token.split(':')[0])).size).toBe(2)
  const peer = parseProgress(putCodexBlock('', replacement, 'b'.repeat(64)))
  expect(peer[0]!.tasks[0]!.steps[replacement.asked!]!.questionToken).not.toBe(tokens.find(token => token.endsWith(':1')))
  const legacy = { ...approval, approvalRevision: undefined }
  expect(putCodexBlock('', legacy, owner)).not.toContain('question=')
  const legacyLedger = observeQuestions(emptyQuestions(), codexProjects(legacy), null, [], NOW, true).ledger
  const missing = observeQuestions(legacyLedger, [], null, [], NOW + 1, true).ledger
  expect(missing.records.filter(record => record.isUnresolved)).toHaveLength(1)
})

test('board-confirmed Codex completion checks the exact token-bearing rendering', () => {
  const approval = event(event(null, 'UserPromptSubmit', 'turn-1'), 'PermissionRequest', 'turn-1')
  const block = putCodexBlock('', approval, owner).replace('state=waiting', 'state=done').replace(/^- \[[ ?]\]/gm, '- [x]')
  expect(boardConfirmedReport(block, approval, owner).state).toBe('done')
  expect(boardConfirmedReport(block.replace(/question=[a-f0-9]{64}:1/, `question=${'b'.repeat(64)}:1`), approval, owner)).toBe(approval)
})


test('retainApproval preserves pending closure and unrelated unanswered tasks without mutating inputs', () => {
  const base = applyTaskCreate(emptyMirror('a1b2c3d4-claude-session', 'demo', NOW), { subject: 'Real task' }, '1', NOW)
  const previous = closeApproval(markApproval(base, 'Approve the tool?'))
  const next = applyTaskCreate(clearApproval(previous), { subject: 'Which folder?', metadata: { waiting: 'you' } }, 'unrelated', NOW + 1)
  const before = JSON.stringify({ previous, next })
  const retained = retainApproval(previous, next)
  expect(retained.tasks.find(one => one.id === 'approval')).toBe(previous.tasks.find(one => one.id === 'approval'))
  expect(retained.tasks.find(one => one.id === 'unrelated')).toBe(next.tasks.find(one => one.id === 'unrelated'))
  expect(retained.tasks.find(one => one.id === 'unrelated')?.waiting).toBe('you')
  expect(retained.updated).toBe(next.updated)
  expect(JSON.stringify({ previous, next })).toBe(before)
  expect(retainApproval(previous, retained)).toBe(retained)
})

test('retainApproval never overwrites a newer approval or invents an absent approval', () => {
  const base = applyTaskCreate(emptyMirror('a1b2c3d4-claude-session', 'demo', NOW), { subject: 'Real task' }, '1', NOW)
  const previous = closeApproval(markApproval(base, 'Approve the old tool?'))
  const next = markApproval(clearApproval(previous), 'Approve the new tool?')
  const before = JSON.stringify({ previous, next, base })
  expect(retainApproval(previous, next)).toBe(next)
  expect(retainApproval(next, clearApproval(next)).tasks.find(one => one.id === 'approval')).toBe(next.tasks.find(one => one.id === 'approval'))
  expect(retainApproval(base, next)).toBe(next)
  expect(retainApproval(base, base)).toBe(base)
  expect(retainApproval(base, clearApproval(next)).tasks.some(one => one.id === 'approval')).toBe(false)
  expect(JSON.stringify({ previous, next, base })).toBe(before)
})

test('Codex producer counters remain distinct beyond safe integer precision after reload', () => {
  const approval = event(event(null, 'UserPromptSubmit', 'turn-1'), 'PermissionRequest', 'turn-1')
  const large = { ...approval, approvalRevision: '9007199254740992', askedRevision: '9007199254740993' }
  const second = event(JSON.parse(JSON.stringify(large)), 'PermissionRequest', 'turn-1')
  expect(second.approvalRevision).toBe('9007199254740993')
  expect(second.askedRevision).toBe(large.askedRevision)
  expect(putCodexBlock('', second, owner)).toContain(':9007199254740993 -->')
  const third = event(JSON.parse(JSON.stringify(second)), 'PermissionRequest', 'turn-1')
  expect(third.approvalRevision).toBe('9007199254740994')
  const question = event(third, 'Stop', 'turn-1', { question: 'Which folder?' })
  expect(question.askedRevision).toBe('9007199254740994')
  expect(question.approvalRevision).toBe(third.approvalRevision)
})


test('a Codex approval renewal preserves the independent unanswered question token', () => {
  const first = event(event(null, 'UserPromptSubmit', 'turn-1'), 'Stop', 'turn-1', { question: 'Which folder?' })
  const initial = observeQuestions(emptyQuestions(), codexProjects(first), null, [], NOW, true).ledger
  const approval = event(first, 'PermissionRequest', 'turn-1')
  const open = observeQuestions(initial, codexProjects(approval), null, [], NOW + 1, true).ledger
  const closedApproval = event(approval, 'Interrupt', 'turn-1')
  const renewed = event(closedApproval, 'PermissionRequest', 'turn-1')
  const projects = codexProjects(renewed)
  const ledger = observeQuestions(open, projects, null, [], NOW + 2, true).ledger
  expect(renewed.askedRevision).toBe(first.askedRevision)
  expect(renewed.steps[renewed.asked!]).toBe('- [?] Which folder?')
  expect(ledger.records.filter(record => record.isUnresolved)).toHaveLength(2)
  expect(ledger.records.find(record => record.id === initial.records[0]!.id)?.isUnresolved).toBe(true)
  expect(buildView(projects, [], null, NOW + 2, 0, {}, words, [], {}, ledger).waiting).toHaveLength(2)
})

test('host question metadata survives owned-slot capacity and leaves the new-slot policy unchanged', () => {
  const steps = Array.from({ length: 40 }, (_, index) => `- [ ] Task ${index}`)
  const held = [...steps, '- [x] Which folder?']
  const reopened = questionSteps(held, 40, 'waiting', 'Which folder?', false, '9')
  expect(reopened.steps.slice(0, 40)).toEqual(steps)
  expect(reopened.steps).toHaveLength(41)
  expect(reopened.askedRevision).toBe('10')
  const board = questionSteps(reopened.steps, reopened.asked, 'working', undefined, true, reopened.askedRevision)
  expect(board).toEqual(reopened)
  const closed = questionSteps(board.steps, board.asked, 'working', undefined, false, board.askedRevision)
  expect(closed.steps[40]).toBe('- [x] Which folder?')
  expect(closed.askedRevision).toBe('10')
  const noSlot = questionSteps(steps, undefined, 'waiting', 'Brand-new question?')
  expect(noSlot.steps).toEqual(steps)
  expect(noSlot.asked).toBe(undefined)
  expect(noSlot.askedRevision).toBe(undefined)
})


test('internal report validation allows only bounded owned extras and retains input guards', () => {
  const first = event(event(null, 'UserPromptSubmit', 'turn-1'), 'PermissionRequest', 'turn-1')
  const question = event(first, 'Stop', 'turn-1', { question: 'Which folder?' })
  const input = { title: 'Task', state: 'working', steps: Array.from({ length: 40 }, (_, index) => `- [ ] Task ${index}`) }
  const report = codexReport(question, session, input, new Date(NOW).toISOString(), words)
  expect(validateCodexReport(report, session)).toEqual(report)
  expect(() => validateCodexReport({ ...report, session: 'synthetic-other-session' }, session)).toThrow('SESSION_CONFLICT')
  expect(() => validateCodexReport({ ...report, steps: [...report.steps, '- [ ] Overflow'] }, session)).toThrow('INVALID_STEPS')
  expect(() => validateCodexReport({ ...report, approval: undefined }, session)).toThrow('INVALID_STEPS')
  expect(() => validateCodexReport({ ...report, state: 'invalid' as CodexReport['state'] }, session)).toThrow('INVALID_STATE')
  expect(() => validateCodexReport({ ...report, steps: ['not a step'] }, session)).toThrow('INVALID_STEP')
  // Over forty user steps, the first forty are kept and the rest are reported as dropped, not refused (#1140).
  expect(() => codexReport(report, session, { ...input, steps: report.steps }, report.updated, words)).not.toThrow()
})

test('identical Codex Stop replay keeps a resolved question closed but real asks renew it', () => {
  const started = event(null, 'UserPromptSubmit', 'turn-1')
  const early = event(started, 'Stop', 'turn-1')
  const first = event(early, 'Stop', 'turn-1', { question: 'Which folder?' })
  const open = observeQuestions(emptyQuestions(), codexProjects(first), null, [], NOW, true).ledger
  const oldId = open.records.find(record => record.isUnresolved)!.id
  const resolved = resolveQuestion(open, oldId, NOW + 1)
  const replay = event(JSON.parse(JSON.stringify(first)), 'Stop', 'turn-1', { question: '  Which   folder?  ' })
  const projects = codexProjects(replay)
  const held = observeQuestions(resolved, projects, null, [], NOW + 2, true).ledger
  expect(held.records.filter(record => record.isUnresolved)).toHaveLength(0)
  expect(buildView(projects, [], null, NOW + 2, 0, {}, words, [], {}, held).waiting).toHaveLength(0)
  expect(replay.askedRevision).toBe(first.askedRevision)
  const changed = event(replay, 'Stop', 'turn-1', { question: 'Which branch?' })
  expect(changed.askedRevision).not.toBe(first.askedRevision)
  const changedLedger = observeQuestions(held, codexProjects(changed), null, [], NOW + 3, true).ledger
  expect(changedLedger.records.filter(record => record.isUnresolved)).toHaveLength(1)
  const working = event(replay, 'UserPromptSubmit', 'turn-2', {}, NOW + 1)
  const renewed = event(working, 'Stop', 'turn-2', { question: 'Which folder?' }, NOW + 2)
  const renewedLedger = observeQuestions(held, codexProjects(renewed), null, [], NOW + 3, true).ledger
  expect(renewed.askedRevision).not.toBe(first.askedRevision)
  expect(renewedLedger.records.find(record => record.isUnresolved)?.id).not.toBe(oldId)
  expect(buildView(codexProjects(renewed), [], null, NOW + 3, 0, {}, words, [], {}, renewedLedger).waiting).toHaveLength(1)
})

test('identical idle question status preserves resolved identity across cache reload', () => {
  const base = event(null, 'UserPromptSubmit', 'turn-1')
  const first = { ...base, state: 'waiting' as const, ...questionSteps(base.steps, undefined, 'waiting', 'Which folder?') }
  const open = observeQuestions(emptyQuestions(), codexProjects(first), null, [], NOW, true).ledger
  const resolved = resolveQuestion(open, open.records[0]!.id, NOW + 1)
  const saved: CodexReport = JSON.parse(JSON.stringify(first))
  const replay = { ...saved, ...questionSteps(saved.steps, saved.asked, 'waiting', 'Which folder?', false, saved.askedRevision) }
  const projects = codexProjects(replay)
  const settled = observeQuestions(resolved, projects, null, [], NOW + 2, true).ledger
  expect(settled.records.filter(record => record.isUnresolved)).toHaveLength(0)
  expect(buildView(projects, [], null, NOW + 2, 0, {}, words, [], {}, settled).waiting).toHaveLength(0)
  expect(replay.askedRevision).toBe(first.askedRevision)
})

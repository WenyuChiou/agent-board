import { test, expect } from 'claude-code/testing'
import { renderAutoBlock } from '../hooks/blocks'
import { codexEvent, codexReport, putCodexBlock } from '../hooks/codex'
import type { CodexReport } from '../hooks/codex'
import { clearApproval, closeApproval, markApproval } from '../hooks/digest'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions } from '../hooks/questions'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'
import type { ProgressMirror } from '../types'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const session = 'synthetic-codex-session'
const owner = 'a'.repeat(64)
const words = STRINGS.en
const projectsOf = (mirror: ProgressMirror) => parseProgress(`## demo\n${renderAutoBlock(mirror, words).join('\n')}\n`)
const codexProjects = (report: CodexReport) => parseProgress(putCodexBlock('', report, owner))
const event = (previous: CodexReport | null, name: string, turn: string, extra: Record<string, unknown> = {}) =>
  codexEvent(previous, { session_id: session, hook_event_name: name, turn_id: turn, ...extra }, new Date(NOW).toISOString(), words)

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

test('a Codex approval or question the hook took back leaves Needs you', () => {
  for (const kind of ['PermissionRequest', 'Stop']) {
    const started = event(null, 'UserPromptSubmit', 'turn-1')
    const waiting = event(started, kind, 'turn-1', kind === 'Stop' ? { question: 'Which folder?' } : {})
    const openProjects = codexProjects(waiting)
    const open = observeQuestions(emptyQuestions(), openProjects, null, [], NOW, true).ledger
    expect(open.records.filter(record => record.isUnresolved)).toHaveLength(1)
    expect(buildView(openProjects, [], null, NOW, 0, {}, words, [], {}, open).waiting).toHaveLength(1)

    const finished = event(waiting, 'UserPromptSubmit', 'turn-2')
    const closedProjects = codexProjects(finished)
    const closed = observeQuestions(open, closedProjects, null, [], NOW + 1, true).ledger
    expect(closed.records.filter(record => record.isUnresolved)).toEqual([])
    expect(buildView(closedProjects, [], null, NOW + 1, 0, {}, words, [], {}, closed).waiting).toEqual([])
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

test('Codex reports carry owned steps as closed within the forty step limit', () => {
  const started = event(null, 'UserPromptSubmit', 'turn-1')
  const approval = event(started, 'PermissionRequest', 'turn-1')
  const question = event(approval, 'Stop', 'turn-1', { question: 'Which folder?' })
  for (const count of [38, 39, 40]) {
    const steps = Array.from({ length: count }, (_, index) => `- [ ] Task ${index}`)
    const report = codexReport(question, session, { title: 'Task', state: 'working', steps }, new Date(NOW).toISOString(), words)
    expect(report.steps).toHaveLength(40)
    if (count < 40) expect(report.steps[report.approval!]).toBe(`- [x] ${words.codexApprovalStep}`)
    else expect(report.approval).toBe(undefined)
    if (count === 38) expect(report.steps[report.asked!]).toBe('- [x] Which folder?')
    else expect(report.asked).toBe(undefined)
    expect(putCodexBlock('', report, owner)).not.toContain('native=codex')
  }
})

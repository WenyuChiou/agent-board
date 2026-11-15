import { test, expect } from 'claude-code/testing'
import { deriveRowState, livenessOf } from '../hooks/row-state'
import type { RowStateInput } from '../hooks/row-state'
import { emptyMirror } from '../hooks/mirror'
import { blockKey, hostHashOf } from '../hooks/session-liveness'
import type { ProgressAuto, ProgressStep } from '../types'

// One row per (events + steps + mirror + liveness) combination → exactly one
// state (#1317). The states 'stopped', 'toCheck' and 'waitingElsewhere' are
// computed here and not shown yet: the rows keep today's rendering until D1
// (#1319) lands. Only 'unsure' is visible in this slice.

const NOW = Date.parse('2026-11-13T12:00:00Z')
const MIN = 60_000
const HOST = hostHashOf('linux', 'test-machine')!

const auto = (state: ProgressAuto['state'], updated: number, over: Partial<ProgressAuto> = {}): ProgressAuto => ({
  session: 'a4000001',
  agent: 'antigravity',
  state,
  updated,
  resume: null,
  dir: null,
  pr: null,
  ci: null,
  ...over,
})
const step = (text: string, status: ProgressStep['status']): ProgressStep => ({ text, status, depth: 0, line: 1, raw: `- [${status === 'done' ? 'x' : status === 'waiting' ? '?' : status === 'blocked' ? '!' : status === 'running' ? '>' : status === 'doing' ? '~' : ' '}] ${text}` })
const placeholder = step('Waiting for the next instruction', 'todo')

const input = (over: Partial<RowStateInput> = {}): RowStateInput => ({
  auto: auto('waiting', NOW - 5 * MIN),
  steps: [step('Check the routes', 'todo')],
  mirror: null,
  events: { hasSessionEnd: false, lastEventAt: NOW - 5 * MIN, host: 'antigravity' },
  liveness: 'unknown',
  now: NOW,
  hasOpenAsk: false,
  ...over,
})

test('a turn ended on a [?] step waits for an answer', () => {
  expect(deriveRowState(input({ steps: [step('Ship the gateway, OK?', 'waiting')], hasOpenAsk: true }))).toBe('answer')
})

test('a turn ended with steps left and no ask stopped, not finished', () => {
  expect(deriveRowState(input({ steps: [step('Check the routes', 'done'), step('Publish the report', 'todo')] }))).toBe('stopped')
})

test('every step done is work to check', () => {
  expect(deriveRowState(input({ auto: auto('waiting', NOW - 5 * MIN), steps: [step('Check the routes', 'done'), step('Publish the report', 'done')] }))).toBe('toCheck')
})

test('a session-end event ends the row', () => {
  expect(deriveRowState(input({ events: { hasSessionEnd: true, lastEventAt: NOW - 5 * MIN, host: 'claude' } }))).toBe('ended')
})

test('an Antigravity row quiet past 30 min with only the placeholder is unsure', () => {
  // The proving case (comment 6845661117): Stop was the last event, the window
  // closed with nothing sent, the conversation still exists — so 'unsure',
  // never 'ended'. Its age is now minus its last move: 31 minutes here.
  const state = deriveRowState(input({
    auto: auto('waiting', NOW - 31 * MIN, { agent: 'antigravity' }),
    steps: [placeholder],
    events: { hasSessionEnd: false, lastEventAt: NOW - 31 * MIN, host: 'antigravity' },
    liveness: 'unknown',
  }))
  expect(state).toBe('unsure')
})

test('the same Antigravity row 29 min quiet is still waiting', () => {
  expect(deriveRowState(input({
    auto: auto('waiting', NOW - 29 * MIN, { agent: 'antigravity' }),
    steps: [placeholder],
    events: { hasSessionEnd: false, lastEventAt: NOW - 29 * MIN, host: 'antigravity' },
    liveness: 'unknown',
  }))).toBe('waiting')
})

test('a [!] step beside an open question still waits for an answer', () => {
  // The answer wins (M7 order); the blocker is named by the row's own
  // rendering (`rowNeedsYou` → stuck reason), not by a second state.
  expect(deriveRowState(input({
    steps: [step('The deploy is blocked by a missing secret', 'blocked'), step('Use the staging secret, OK?', 'waiting')],
    hasOpenAsk: true,
  }))).toBe('answer')
})

test('a row whose only open steps wait on someone else waits elsewhere', () => {
  expect(deriveRowState(input({ steps: [step('Waiting for Prof. Lee to reply', 'running')] }))).toBe('waitingElsewhere')
})

test('a hand-kept task is outside the six states', () => {
  expect(deriveRowState(input({ auto: null, steps: [step('Water the plants', 'todo')] }))).toBe('manual')
})

test('a claimed process proven gone ends the row', () => {
  expect(deriveRowState(input({
    auto: auto('working', NOW - 5 * MIN, { agent: 'claude' }),
    steps: [step('Check the routes', 'doing')],
    liveness: 'dead',
  }))).toBe('ended')
})

test('a live process keeps a quiet placeholder row waiting', () => {
  expect(deriveRowState(input({
    auto: auto('waiting', NOW - 31 * MIN, { agent: 'claude' }),
    steps: [placeholder],
    events: { hasSessionEnd: false, lastEventAt: NOW - 31 * MIN, host: 'claude' },
    liveness: 'alive',
  }))).toBe('waiting')
})

test('a mirror task waiting on the person waits for an answer', () => {
  const mirror = emptyMirror('session-1', 'api-gateway', NOW)
  mirror.tasks = [{ id: '1', subject: 'Ship the gateway', status: 'pending', activeForm: '', waiting: 'you', why: 'Needs a yes', ask: 'confirm', options: [], command: null, link: null, blocked: null, blockedBy: [] }]
  expect(deriveRowState(input({ mirror, steps: [step('Ship the gateway', 'todo')] }))).toBe('answer')
})

test('a working row with real steps left is still working', () => {
  expect(deriveRowState(input({
    auto: auto('working', NOW - 5 * MIN),
    steps: [step('Check the routes', 'doing')],
    events: { hasSessionEnd: false, lastEventAt: NOW - 5 * MIN, host: 'codex' },
  }))).toBe('working')
})

test('a placeholder-only row with no usable age cannot tell', () => {
  expect(deriveRowState(input({
    auto: auto('waiting', 0),
    steps: [placeholder],
    events: { hasSessionEnd: false, lastEventAt: 0, host: 'antigravity' },
  }))).toBe('cannotTell')
})

test('a pending approval from the host permission event waits for approval', () => {
  expect(deriveRowState(input({ hasApproval: true }))).toBe('approval')
})

test('an open ask on a quiet placeholder row stays in Needs you', () => {
  // Q5: 'unsure' is not confirmed ended, so a pending ask is not folded by it.
  expect(deriveRowState(input({
    auto: auto('waiting', NOW - 31 * MIN, { agent: 'antigravity' }),
    steps: [placeholder, step('Ship the gateway, OK?', 'waiting')],
    events: { hasSessionEnd: false, lastEventAt: NOW - 31 * MIN, host: 'antigravity' },
    hasOpenAsk: true,
  }))).toBe('answer')
})

test('a session-end event ends the row even with an open ask', () => {
  expect(deriveRowState(input({
    steps: [step('Ship the gateway, OK?', 'waiting')],
    events: { hasSessionEnd: true, lastEventAt: NOW - 5 * MIN, host: 'claude' },
    hasOpenAsk: true,
  }))).toBe('ended')
})

test('a working row quiet past 12 h is ended, as today', () => {
  expect(deriveRowState(input({
    auto: auto('working', NOW - 13 * 60 * MIN),
    steps: [step('Check the routes', 'doing')],
    events: { hasSessionEnd: false, lastEventAt: NOW - 13 * 60 * MIN, host: 'codex' },
  }))).toBe('ended')
})

test('a placeholder row quiet past 12 h is ended, not unsure', () => {
  expect(deriveRowState(input({
    auto: auto('waiting', NOW - 13 * 60 * MIN, { agent: 'antigravity' }),
    steps: [placeholder],
    events: { hasSessionEnd: false, lastEventAt: NOW - 13 * 60 * MIN, host: 'antigravity' },
  }))).toBe('ended')
})

test('a configured stale timeout ends a working row past it, not past 12 h', () => {
  // Greptile P1 on #1406: with --stale-ms 60000 a two-minute-old working
  // block already reads Stopped elsewhere, so the derivation must agree.
  expect(deriveRowState(input({
    auto: auto('working', NOW - 2 * MIN),
    steps: [step('Check the routes', 'doing')],
    events: { hasSessionEnd: false, lastEventAt: NOW - 2 * MIN, host: 'codex' },
    staleMs: MIN,
  }))).toBe('ended')
})

test('a configured stale timeout longer than 12 h keeps a live row working', () => {
  // The other half of the same P1: a timeout past 12 h must not end a live
  // row the 12 h backstop would have ended.
  expect(deriveRowState(input({
    auto: auto('working', NOW - 13 * 60 * MIN),
    steps: [step('Check the routes', 'doing')],
    events: { hasSessionEnd: false, lastEventAt: NOW - 13 * 60 * MIN, host: 'codex' },
    staleMs: 24 * 60 * MIN,
  }))).toBe('working')
})

test('livenessOf reads dead, alive and unknown from the gone set', () => {
  const claimed = auto('working', NOW - 5 * MIN, { agent: 'claude', agentPid: 1234, agentStarted: NOW - 60 * MIN, host: HOST })
  expect(livenessOf(claimed, new Set([blockKey(claimed)]))).toBe('dead')
  expect(livenessOf(claimed, new Set())).toBe('alive')
  expect(livenessOf(auto('waiting', NOW - 31 * MIN, { agent: 'antigravity' }), new Set())).toBe('unknown')
  expect(livenessOf(null, new Set())).toBe('unknown')
})

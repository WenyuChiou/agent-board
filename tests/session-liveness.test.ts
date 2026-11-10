import { test, expect } from 'claude-code/testing'
import { parseProgress, STALE_MS } from '../hooks/parse'
import { buildView } from '../hooks/view'
import { emptyQuestions, observeQuestions, questionScope } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { renderAutoBlock } from '../hooks/blocks'
import { emptyMirror, withAgentIdentity } from '../hooks/mirror'
import type { ProgressMirror } from '../types'
import { agentClaimOf, hostHashOf, isDeadAgent } from '../hooks/session-liveness'
import { boardDocument } from '../hooks/board-json'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'

// The pure half of the #1092 liveness tests: the view, the ledger, the marker and
// the decision. The shell half (deriving the dead set from real pids, and the
// batched start-time lookup) lives in tests/session-liveness.test.mjs, because a
// .ts test under `claude plugin test` may import only `claude-code` and relative
// hooks modules — never `node:` and never `scripts/`. The dead set here is a
// synthetic scope string, exactly the set the shell would hand buildView.
const NOW = Date.parse('2026-10-16T12:00:00Z')
const words = STRINGS.en
// A fixed host hash for the test's blocks, in the hostHashOf form.
const host = hostHashOf('linux', 'testhost') ?? ''
// Fixed pids: the view reads only the dead set, never the pid itself, so the
// numbers are labels here; the shell proves them against the kernel in .mjs.
const livePid = 1234
const deadPidValue = 999999999
const liveStarted = NOW - 1000

type Claim = { pid: number; started?: number; host?: string }
const block = (id: string, agent: string, state: string, steps: string, claim: Claim | null, minutes = 5): string => {
  const attrs = claim === null ? '' : ` agentpid=${claim.pid}${claim.started === undefined ? '' : ` agentstarted=${claim.started}`}${claim.host === undefined ? '' : ` host=${claim.host}`}`
  return `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - minutes * 60_000).toISOString()}${attrs} -->\n### Ship ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
}
const file = (...blocks: string[]): string => `## demo\n${blocks.join('')}`
// The dead set, as the shell would derive it for one dead session.
const deadScope = (id: string): ReadonlySet<string> => new Set([questionScope('demo', 'claude', id)])
const observe = (ledger: QuestionLedger, text: string, deadSessions: ReadonlySet<string>, settled = true) =>
  observeQuestions(ledger, parseProgress(text), null, [], NOW, settled, 'preview', undefined, [], [], new Set(), deadSessions)
// Observe a question while its session is alive, then again after the window
// closed: the record the first pass created is what the second pass retains.
const observeTwice = (text: string, deadSessions: ReadonlySet<string>): QuestionLedger =>
  observe(observe(emptyQuestions(), text, new Set()).ledger, text, deadSessions).ledger
const viewOf = (text: string, deadSessions: ReadonlySet<string>, ledger: QuestionLedger) =>
  buildView(parseProgress(text), [], null, NOW, 0, {}, words, [], {}, ledger, undefined, [], new Set(), undefined, STALE_MS, undefined, deadSessions)
// A row lives in its project's group while the session works, and under Stopped
// once it is ended.
const rowOf = (view: ReturnType<typeof buildView>, title: string) =>
  view.groups.flatMap(group => group.rows).find(row => row.title === title)
  ?? view.stopped.find(row => row.title === title)

test('a waiting approval whose agent window is closed leaves Needs you and folds into Older unanswered', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const scopes = deadScope('a1b2c3d4')
  const ledger = observeTwice(text, scopes)
  const record = ledger.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  expect(record!.isPresent).toBe(false)
  expect(record!.isWaiting).toBe(false)
  expect(record!.isUnresolved).toBe(true)
  const view = viewOf(text, scopes, ledger)
  expect(view.waiting.map(item => item.text)).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row).toBeDefined()
  expect(row!.auto).toBe('ended')
  expect(row!.tone).toBe('warn')
  expect(row!.archive).not.toBe(null)
})

test('an AskUserQuestion step whose agent window is closed leaves Needs you and keeps its options under Older', () => {
  const text = file(block('b2c3d4e5', 'claude', 'waiting', '- [?] Which plan, A or B?\n<!-- native=claude options=["A","B"] -->', { pid: deadPidValue, started: liveStarted, host }))
  const scopes = deadScope('b2c3d4e5')
  const view = viewOf(text, scopes, observeTwice(text, scopes))
  expect(view.waiting.map(item => item.text)).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Which plan, A or B?'])
  expect(view.older[0]!.options).toEqual(['A', 'B'])
})

test('a waiting approval whose agent is alive stays in Needs you with its reply box', () => {
  const text = file(block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const view = viewOf(text, new Set(), observe(emptyQuestions(), text, new Set()).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual([])
})

test('a resumed session with a live pid raises its folded question again', () => {
  const before = file(block('d4e5f6a7', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const folded = viewOf(before, deadScope('d4e5f6a7'), observeTwice(before, deadScope('d4e5f6a7')))
  expect(folded.waiting.map(item => item.text)).toEqual([])
  expect(folded.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  // The session reports again from a live process: same session, same step, a new pid.
  const after = file(block('d4e5f6a7', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const raised = viewOf(after, new Set(), observe(emptyQuestions(), after, new Set()).ledger)
  expect(raised.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(raised.older.map(item => item.text)).toEqual([])
})

test('a live pid with a start time far from the recorded one is a reused pid, so it counts as dead', () => {
  const claim = { pid: livePid, started: liveStarted, host }
  expect(isDeadAgent(claim, host, false, null)).toBe(true)
  expect(isDeadAgent(claim, host, true, liveStarted)).toBe(false)
  expect(isDeadAgent(claim, host, true, liveStarted + 1500)).toBe(false)
  expect(isDeadAgent(claim, host, true, liveStarted + 4000)).toBe(true)
  expect(isDeadAgent(claim, host, true, liveStarted - 4000)).toBe(true)
  expect(isDeadAgent(claim, host, true, 'inaccessible')).toBe(false)
  expect(isDeadAgent(claim, host, true, null)).toBe(false)
  expect(isDeadAgent({ pid: livePid, host }, host, true, liveStarted + 4000)).toBe(false)
  expect(isDeadAgent(claim, sha256('another-host'), false, null)).toBe(false)
  expect(agentClaimOf({ agentPid: livePid, agentStarted: liveStarted, host })).toEqual(claim)
  expect(agentClaimOf({ agentPid: 0, agentStarted: liveStarted, host })).toBe(null)
  expect(agentClaimOf({ agentPid: livePid, agentStarted: -1, host })).toBe(null)
  expect(agentClaimOf({ agentPid: livePid, agentStarted: liveStarted, host: 'short' })).toBe(null)
  expect(agentClaimOf(null)).toBe(null)
  expect(hostHashOf('win32', 'PC-CF8474CB7D')).not.toBe(hostHashOf('linux', 'PC-CF8474CB7D'))
  expect(hostHashOf('win32', 'PC-CF8474CB7D')).toBe(hostHashOf('win32', 'pc-cf8474cb7d'))
  expect(hostHashOf('linux', undefined)).toBe(null)
  expect(hostHashOf('linux', '')).toBe(null)
})

test('a block with the new fields parses, a block without them reads unchanged, and malformed fields are ignored', () => {
  const withFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const parsed = parseProgress(withFields)[0]!.tasks[0]!.auto
  expect(parsed?.agentPid).toBe(livePid)
  expect(parsed?.agentStarted).toBe(liveStarted)
  expect(parsed?.host).toBe(host)
  const withoutFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', null))
  const old = parseProgress(withoutFields)[0]!.tasks[0]!.auto
  expect(old?.agentPid).toBeUndefined()
  expect(old?.agentStarted).toBeUndefined()
  expect(old?.host).toBeUndefined()
  const malformed = file(`<!-- auto session=e5f6a7b8 agent=claude state=waiting updated=${new Date(NOW).toISOString()} agentpid=abc agentstarted=-5 host=short -->\n### Ship e5f6a7b8\n- [?] Deploy the synthetic build, OK?\n<!-- /auto session=e5f6a7b8 -->\n`)
  const bad = parseProgress(malformed)[0]!.tasks[0]!.auto
  expect(bad?.agentPid).toBeUndefined()
  expect(bad?.agentStarted).toBeUndefined()
  expect(bad?.host).toBeUndefined()
  // The fields alone never fold a question: only the dead set does.
  const view = viewOf(withFields, new Set(), observe(emptyQuestions(), withFields, new Set()).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual([])
})

test('the pid and host hash appear nowhere in --json output, the page model or the LAN page model', () => {
  const text = file(block('f6a7b8c9', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  expect(text).toContain(`agentpid=${deadPidValue}`)
  expect(text).toContain(`host=${host}`)
  const scopes = deadScope('f6a7b8c9')
  const view = viewOf(text, scopes, observeTwice(text, scopes))
  const json = JSON.stringify(boardDocument(view, [], [], words, '', false, NOW))
  expect(json).not.toContain(String(deadPidValue))
  expect(json).not.toContain(host)
  const page = JSON.stringify(serveModel(view, [], words, new Set(), false, undefined, false))
  expect(page).not.toContain(String(deadPidValue))
  expect(page).not.toContain(host)
  const lan = JSON.stringify(serveModel(view, [], words, new Set(), true, undefined, false))
  expect(lan).not.toContain(String(deadPidValue))
  expect(lan).not.toContain(host)
})

test('a session whose host hash differs from the reading machine is never folded by the pid check', () => {
  const otherHost = sha256('another-machine')
  expect(otherHost).not.toBe(host)
  // The decision itself refuses a mismatched host, dead pid or not.
  expect(isDeadAgent({ pid: deadPidValue, started: liveStarted, host: otherHost }, host, false, null)).toBe(false)
  expect(isDeadAgent({ pid: deadPidValue, started: liveStarted, host: otherHost }, host, true, liveStarted)).toBe(false)
  const text = file(block('a7b8c9d0', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host: otherHost }))
  const view = viewOf(text, new Set(), observe(emptyQuestions(), text, new Set()).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual([])
})

test('a non-Claude agent records no pid, and its waiting card stays until the 12 h rule', () => {
  const identity = { pid: livePid, started: liveStarted, host }
  const claude = emptyMirror('a1b2c3d4-person-a', 'demo', NOW, '', 'claude')
  expect(withAgentIdentity(claude, identity).agentPid).toBe(livePid)
  const codex = emptyMirror('a1b2c3d4-person-b', 'demo', NOW, '', 'codex')
  expect(withAgentIdentity(codex, identity).agentPid).toBeUndefined()
  expect(withAgentIdentity(claude, null).agentPid).toBeUndefined()
  // Even when the hook sees an identity, a Codex block carries no pid in its marker.
  const codexWithPid: ProgressMirror = { ...codex, agentPid: livePid, agentStarted: liveStarted, host }
  const marker = renderAutoBlock(codexWithPid, words).join('\n')
  expect(marker).not.toContain('agentpid=')
  expect(marker).not.toContain('agentstarted=')
  expect(marker).not.toContain('host=')
  const claudeWithPid: ProgressMirror = { ...claude, agentPid: livePid, agentStarted: liveStarted, host }
  const claudeMarker = renderAutoBlock(claudeWithPid, words).join('\n')
  expect(claudeMarker).toContain(`agentpid=${livePid}`)
  expect(claudeMarker).toContain(`agentstarted=${liveStarted}`)
  expect(claudeMarker).toContain(`host=${host}`)
  // A Codex block that somehow carries pid fields is never in the dead set, so its
  // waiting card stays: the shell (tests/session-liveness.test.mjs) proves the set
  // itself excludes it.
  const text = file(block('b8c9d0e1', 'codex', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const view = viewOf(text, new Set(), observe(emptyQuestions(), text, new Set()).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
})

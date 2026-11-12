import { test, expect } from 'claude-code/testing'
import { parseProgress, STALE_MS } from '../hooks/parse'
import { parseProgress as parseProgress0243 } from './fixtures/parse-0.24.3/parse'
import { buildView } from '../hooks/view'
import { emptyQuestions, observeQuestions, resolveQuestion, sourceData } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { confirmTask, renderAutoBlock, takeTask } from '../hooks/blocks'
import { completionOverlay, emptyMirror, withAgentIdentity } from '../hooks/mirror'
import type { ProgressAuto, ProgressMirror } from '../types'
import { agentClaimOf, deadKeysForClaims, deadSessionKey, hostHashOf, isDeadAgent, sessionClaimsOf, withoutProcessIdentity } from '../hooks/session-liveness'
import { boardDocument } from '../hooks/board-json'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'

// The pure half of the #1092 liveness tests: the view, the ledger, the marker and
// the decision. The shell half (deriving the dead set from real pids, and the
// batched start-time lookup) lives in tests/session-liveness.test.mjs, because a
// .ts test under `claude plugin test` may import only `claude-code` and relative
// hooks modules — never `node:` and never `scripts/`. The dead set here is a
// synthetic identity key (agent + full session id), exactly the set the shell
// would hand buildView.
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
const block = (id: string, agent: string, state: string, steps: string, claim: Claim | null, minutes = 5, resume: string | null = null): string => {
  const attrs = claim === null ? '' : ` agentpid=${claim.pid}${claim.started === undefined ? '' : ` agentstarted=${claim.started}`}${claim.host === undefined ? '' : ` host=${claim.host}`}`
  return `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - minutes * 60_000).toISOString()}${resume === null ? '' : ` resume=${resume}`}${attrs} -->\n### Ship ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
}
const file = (...blocks: string[]): string => `## demo\n${blocks.join('')}`
// The dead set, as the shell would derive it for one dead session: the identity
// key, not the question scope — a live session sharing the short id must not fold.
const deadKey = (id: string, resume: string | null = null): ReadonlySet<string> => new Set([`claude\u0000${resume ?? id}`])
const observe = (ledger: QuestionLedger, text: string, deadSessions: ReadonlySet<string>, settled = true) =>
  observeQuestions(ledger, parseProgress(text), null, [], NOW, settled, 'preview', undefined, [], [], new Set(), deadSessions)
// Observe a question while its session is alive, then again after the window
// closed: the record the first pass created is what the second pass retains.
const observeTwice = (text: string, deadSessions: ReadonlySet<string>): QuestionLedger =>
  observe(observe(emptyQuestions(), text, new Set()).ledger, text, deadSessions).ledger
const viewOf = (text: string, deadSessions: ReadonlySet<string>, ledger: QuestionLedger, answered: string[] = []) =>
  buildView(parseProgress(text), [], null, NOW, 0, {}, words, answered, {}, ledger, undefined, [], new Set(), undefined, STALE_MS, undefined, deadSessions)
// A row lives in its project's group while the session works, and under Stopped
// once it is ended.
const rowOf = (view: ReturnType<typeof buildView>, title: string) =>
  view.groups.flatMap(group => group.rows).find(row => row.title === title)
  ?? view.stopped.find(row => row.title === title)

test('a waiting approval whose agent window is closed leaves Needs you and folds into Older unanswered', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const ledger = observeTwice(text, dead)
  const record = ledger.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  expect(record!.isPresent).toBe(false)
  expect(record!.isWaiting).toBe(false)
  expect(record!.isUnresolved).toBe(true)
  const view = viewOf(text, dead, ledger)
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
  const dead = deadKey('b2c3d4e5')
  const view = viewOf(text, dead, observeTwice(text, dead))
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
  const folded = viewOf(before, deadKey('d4e5f6a7'), observeTwice(before, deadKey('d4e5f6a7')))
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
  const dead = deadKey('f6a7b8c9')
  const settled = observeTwice(text, dead)
  const view = viewOf(text, dead, settled)
  // The ledger's records carry the block's data, so they must not carry the pid either.
  const ledgerJson = JSON.stringify(settled)
  expect(ledgerJson).not.toContain(String(deadPidValue))
  expect(ledgerJson).not.toContain(host)
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

// Round 2: the two P1s the first review left. The guards accept what the stopped
// row offers only when the caller hands them the dead-session evidence; the
// observation keeps a dead question's identity, so the row can name it and a
// never-recorded one still reaches Older unanswered.
test('a dead-but-recent stopped row\'s confirm and archive go through with dead-session evidence and are refused without it', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const view = viewOf(text, dead, observeTwice(text, dead))
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row).toBeDefined()
  expect(row!.archive).not.toBe(null)
  expect(row!.confirm).not.toBe(null)
  if (row!.archive === null || row!.confirm === null) throw new Error('stopped row actions missing')
  const isSessionDead = (_project: string, auto: ProgressAuto): boolean => dead.has(deadSessionKey(auto))
  const archived = takeTask(text, row.archive, NOW, words, {}, STALE_MS, isSessionDead)
  expect(archived).not.toBe(null)
  expect(archived?.text).not.toContain('Ship a1b2c3d4')
  const confirmed = confirmTask(text, row.confirm, NOW, words, {}, STALE_MS, isSessionDead)
  expect(confirmed?.text).toContain('state=done')
  // Without the evidence the guards keep the old refusal, as the plugin's calls
  // do: it never computes the dead set. Evidence for another session does not
  // open this one either.
  expect(takeTask(text, row.archive, NOW, words, {}, STALE_MS)).toBe(null)
  expect(confirmTask(text, row.confirm, NOW, words, {}, STALE_MS)).toBe(null)
  const otherDead = (_project: string, auto: ProgressAuto): boolean => deadKey('b2c3d4e5').has(deadSessionKey(auto))
  expect(takeTask(text, row.archive, NOW, words, {}, STALE_MS, otherDead)).toBe(null)
  expect(confirmTask(text, row.confirm, NOW, words, {}, STALE_MS, otherDead)).toBe(null)
})

test('a question answered before the window closed does not ask again on its stopped row', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const settled = observeTwice(text, dead)
  const record = settled.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  const resolved = resolveQuestion(settled, record!.id, NOW + 1)
  expect(resolved.records.find(one => one.id === record!.id)?.isUnresolved).toBe(false)
  const view = viewOf(text, dead, resolved)
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.question).toBe(null)
  expect(row?.questions ?? []).toEqual([])
  expect(view.waiting).toEqual([])
  expect(view.older).toEqual([])
})

test('a question hidden before the window closed keeps its record identity and does not ask again', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const settled = observeTwice(text, dead)
  const record = settled.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  const view = viewOf(text, dead, settled, [record!.id])
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.question).toBe(null)
  expect(row?.questions ?? []).toEqual([])
  expect(view.hidden.map(item => item.hideKey)).toEqual([record!.id])
  expect(view.hidden.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older).toEqual([])
  expect(view.waiting).toEqual([])
})

test('a question never recorded before the window closed is recorded as retained and reaches Older unanswered', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const ledger = observe(emptyQuestions(), text, dead).ledger
  const record = ledger.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  expect(record!.isPresent).toBe(false)
  expect(record!.isWaiting).toBe(false)
  expect(record!.isUnresolved).toBe(true)
  const view = viewOf(text, dead, ledger)
  expect(view.waiting).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.questions?.map(question => question.questionId)).toEqual([record!.id])
  expect(row?.questions?.map(question => question.hideKey)).toEqual([record!.id])
})

test('a second read of the same dead question reuses its retained record instead of recording it twice', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const once = observeTwice(text, dead)
  expect(once.records).toHaveLength(1)
  const again = observe(once, text, dead).ledger
  expect(again.records).toHaveLength(1)
  expect(again.records[0]!.id).toBe(once.records[0]!.id)
  expect(again.records[0]!.isPresent).toBe(false)
  expect(again.records[0]!.isWaiting).toBe(false)
  expect(again.records[0]!.isUnresolved).toBe(true)
  const view = viewOf(text, dead, again)
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
})

test('a step ticked after the window closed resolves its retained record instead of asking again', () => {
  const before = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const settled = observeTwice(before, dead)
  expect(settled.records.find(one => one.isUnresolved)).toBeDefined()
  const after = file(block('a1b2c3d4', 'claude', 'waiting', '- [x] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const ledger = observe(settled, after, dead).ledger
  const record = ledger.records.find(one => one.id === settled.records[0]!.id)
  expect(record?.isUnresolved).toBe(false)
  const view = viewOf(after, dead, ledger)
  expect(view.older).toEqual([])
  expect(view.waiting).toEqual([])
})

// Round 3: the seven P1s the second review left. A resume with no identity must
// not keep the exited process's (finding 1); a claim that omits its start time
// clears the old one, so a new pid with the old start never marks the live
// session dead.
test('a resume with no host clears the old pid, start time and host, and a claim without a start time clears the old one', () => {
  const identity = { pid: livePid, started: liveStarted, host }
  const claude = emptyMirror('a1b2c3d4-person-a', 'demo', NOW, '', 'claude')
  const stamped = withAgentIdentity(claude, identity)
  expect(stamped.agentPid).toBe(livePid)
  expect(stamped.agentStarted).toBe(liveStarted)
  expect(stamped.host).toBe(host)
  const resumed = withAgentIdentity(stamped, null)
  expect(resumed.agentPid).toBeUndefined()
  expect(resumed.agentStarted).toBeUndefined()
  expect(resumed.host).toBeUndefined()
  // The new process's pid replaces the old one, and the old start goes with it.
  const restamped = withAgentIdentity(stamped, { pid: 5678, host })
  expect(restamped.agentPid).toBe(5678)
  expect(restamped.agentStarted).toBeUndefined()
  expect(restamped.host).toBe(host)
})

test('a dead session sharing a short id never folds the live one, and a dead duplicate never decides the live winner', () => {
  // Two sessions share the short id a1b2c3d4 but carry different full ids: the
  // dead one's key is its own, so only its row folds.
  const liveResume = '1111111111111111111111111111111111111111111111111111111111111111'
  const deadResume = '2222222222222222222222222222222222222222222222222222222222222222'
  const text = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }, 5, liveResume),
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Which plan, A or B?', { pid: deadPidValue, started: liveStarted, host }, 5, deadResume),
  )
  const projects = parseProgress(text)
  const claims = sessionClaimsOf(projects)
  expect(claims.map(one => one.key).sort()).toEqual([`claude\u0000${deadResume}`, `claude\u0000${liveResume}`].sort())
  const dead = deadKeysForClaims(claims, pid => pid === deadPidValue, host)
  expect([...dead]).toEqual([`claude\u0000${deadResume}`])
  const first = observe(emptyQuestions(), text, new Set()).ledger
  const settled = observe(first, text, dead).ledger
  const view = viewOf(text, dead, settled)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual(['Which plan, A or B?'])
  // A dead duplicate of the live session: the newest claim decides, so the dead
  // set stays empty and the live winner's row stays.
  const twin = file(
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }, 9, liveResume),
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }, 5, liveResume),
  )
  const twinClaims = sessionClaimsOf(parseProgress(twin))
  expect(twinClaims).toHaveLength(1)
  expect(twinClaims[0]!.claim.pid).toBe(livePid)
  expect(deadKeysForClaims(twinClaims, pid => pid === deadPidValue, host).size).toBe(0)
})

test('after close, resume and close again the stopped row names the current incarnation, not the oldest', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  // Live: R1. Closed: R1 retained. Resumed (live again): the retained record is
  // no candidate, so the live pass records R2. Closed again: the dead pass
  // picks R2, the latest unresolved incarnation.
  const first = observe(emptyQuestions(), text, new Set()).ledger
  const closed = observe(first, text, dead).ledger
  const resumed = observe(closed, text, new Set()).ledger
  const closedAgain = observe(resumed, text, dead).ledger
  const records = closedAgain.records.filter(one => one.isUnresolved)
  expect(records).toHaveLength(2)
  const view = viewOf(text, dead, closedAgain)
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.questions?.map(question => question.questionId)).toEqual([records[1]!.id])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.waiting).toEqual([])
})

test('after close, resume and close again the stopped row names the current incarnation for a producer-token question too', () => {
  const token = `${'b'.repeat(64)}:1`
  const text = file(block('a1b2c3d4', 'claude', 'waiting', `- [?] Deploy the synthetic build, OK?\n<!-- question=${token} -->`, { pid: deadPidValue, started: liveStarted, host }))
  const dead = deadKey('a1b2c3d4')
  const first = observe(emptyQuestions(), text, new Set()).ledger
  expect(first.records[0]?.producer).toBe(token)
  const closed = observe(first, text, dead).ledger
  const resumed = observe(closed, text, new Set()).ledger
  const closedAgain = observe(resumed, text, dead).ledger
  const records = closedAgain.records.filter(one => one.isUnresolved)
  expect(records).toHaveLength(2)
  expect(records[1]!.producer).toBe(token)
  const view = viewOf(text, dead, closedAgain)
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.questions?.map(question => question.questionId)).toEqual([records[1]!.id])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.waiting).toEqual([])
})

test('the pid and host hash appear nowhere in a record source, a stored mirror or a completion overlay', () => {
  const text = file(block('f6a7b8c9', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const task = parseProgress(text)[0]!.tasks[0]!
  expect(sourceData(task)).not.toContain(String(deadPidValue))
  expect(sourceData(task)).not.toContain(host)
  // A stored mirror and a completion overlay drop the same three fields.
  const mirror: ProgressMirror = { ...emptyMirror('a1b2c3d4-person-a', 'demo', NOW, '', 'claude'), agentPid: livePid, agentStarted: liveStarted, host }
  expect(JSON.stringify(withoutProcessIdentity(mirror))).not.toContain(String(livePid))
  expect(JSON.stringify(withoutProcessIdentity(mirror))).not.toContain(host)
  const overlay = completionOverlay('agent:a1b2c3d4', mirror, NOW)
  expect(JSON.stringify(overlay.completed)).not.toContain(String(livePid))
  expect(JSON.stringify(overlay.completed)).not.toContain(host)
})

test('the plugin settling a question and the board script reading it agree, so a settled question does not flip back to waiting', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const projects = parseProgress(text)
  // The plugin's evidence is a kill probe only: the pid is gone, so the session is dead.
  const pluginDead = deadKeysForClaims(sessionClaimsOf(projects), pid => pid === deadPidValue, host)
  expect([...pluginDead]).toEqual([deadSessionKey(projects[0]!.tasks[0]!.auto!)])
  // Live, then closed (the plugin settles), then the board script reads the same
  // file: one record, still retained, still the stopped row's question — never
  // waiting again.
  const first = observe(emptyQuestions(), text, new Set()).ledger
  const settled = observe(first, text, pluginDead).ledger
  const reread = observe(settled, text, pluginDead).ledger
  expect(reread.records).toHaveLength(1)
  expect(reread.records[0]!.isUnresolved).toBe(true)
  expect(reread.records[0]!.isPresent).toBe(false)
  expect(reread.records[0]!.isWaiting).toBe(false)
  const view = viewOf(text, pluginDead, reread)
  expect(view.waiting).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.questions?.map(question => question.questionId)).toEqual([reread.records[0]!.id])
  // The control: the same reread with no evidence records the question again —
  // the flip the plugin's evidence exists to stop.
  const flipped = observe(settled, text, new Set()).ledger
  expect(flipped.records.filter(one => one.isUnresolved)).toHaveLength(2)
})

test('a 0.24.3-era board reads a block with the new fields, and the new board reads an old block unchanged', () => {
  const withFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const old = parseProgress0243(withFields)[0]!.tasks[0]!
  expect(old.auto?.session).toBe('e5f6a7b8')
  expect(old.auto?.agent).toBe('claude')
  expect(old.auto?.state).toBe('waiting')
  expect(old.steps.map(step => step.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(old.steps[0]!.status).toBe('waiting')
  // Unknown attributes are ignored, not read as identity: the old board never
  // folds on them, and never claims to know the pid.
  expect(old.auto?.agentPid).toBeUndefined()
  expect(old.auto?.agentStarted).toBeUndefined()
  expect(old.auto?.host).toBeUndefined()
  const withoutFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', null))
  const oldBlock = parseProgress(withoutFields)[0]!.tasks[0]!.auto
  expect(oldBlock?.agentPid).toBeUndefined()
  expect(oldBlock?.agentStarted).toBeUndefined()
  expect(oldBlock?.host).toBeUndefined()
})

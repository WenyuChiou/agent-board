import { test, expect } from 'claude-code/testing'
import { isStopped, parseProgress, STALE_MS } from '../hooks/parse'
import { parseProgress as parseProgress0243 } from './fixtures/parse-0.24.3/parse'
import { buildView } from '../hooks/view'
import { emptyQuestions, observeQuestions, questionsJson, resolveQuestion, sourceData } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { confirmTask, renderAutoBlock, takeTask } from '../hooks/blocks'
import { completionOverlay, emptyMirror, withAgentIdentity } from '../hooks/mirror'
import type { ProgressAuto, ProgressMirror } from '../types'
import { agentClaimOf, blockKey, claimedBlocksOf, goneBlocks, hostHashOf, isDeadAgent, withoutProcessIdentity } from '../hooks/session-liveness'
import { boardDocument } from '../hooks/board-json'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'
import { sha256 } from '../hooks/sha256'

// The pure half of the #1092 liveness tests: the view, the ledger, the marker and
// the decision. The shell half (deriving `gone` from real pids, batched start-time
// lookups, CLI archive, and the source-scan guard) lives in tests/session-liveness.test.mjs,
// because a .ts test under `claude plugin test` may import only `claude-code` and
// relative hooks modules — never `node:` and never `scripts/`.
const NOW = Date.parse('2026-10-16T12:00:00Z')
const words = STRINGS.en
const host = hostHashOf('linux', 'testhost') ?? ''
const livePid = 1234
const deadPidValue = 999999999
const liveStarted = NOW - 1000

type Claim = { pid: number; started?: number; host?: string }
const block = (id: string, agent: string, state: string, steps: string, claim: Claim | null, minutes = 5, resume: string | null = null): string => {
  const attrs = claim === null ? '' : ` agentpid=${claim.pid}${claim.started === undefined ? '' : ` agentstarted=${claim.started}`}${claim.host === undefined ? '' : ` host=${claim.host}`}`
  return `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(NOW - minutes * 60_000).toISOString()}${resume === null ? '' : ` resume=${resume}`}${attrs} -->\n### Ship ${id}\n${steps}\n<!-- /auto session=${id} -->\n`
}
const file = (...blocks: string[]): string => `## demo\n${blocks.join('')}`
const goneFor = (text: string, deadPids: ReadonlySet<number> = new Set([deadPidValue])): ReadonlySet<string> =>
  goneBlocks(parseProgress(text), claim => ({ alive: !deadPids.has(claim.pid), actual: null }), host)
const observe = (ledger: QuestionLedger, text: string, settled = true) =>
  observeQuestions(ledger, parseProgress(text), null, [], NOW, settled, 'preview')
const viewOf = (text: string, gone: ReadonlySet<string>, ledger: QuestionLedger, answered: string[] = []) =>
  buildView(parseProgress(text), [], null, NOW, 0, {}, words, answered, {}, ledger, undefined, [], new Set(), undefined, STALE_MS, undefined, gone)
const rowOf = (view: ReturnType<typeof buildView>, title: string) =>
  view.groups.flatMap(group => group.rows).find(row => row.title === title)
  ?? view.stopped.find(row => row.title === title)

test('a waiting approval whose agent window is closed leaves Needs you and folds into Older unanswered', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const gone = goneFor(text)
  const ledger = observe(emptyQuestions(), text).ledger
  const record = ledger.records.find(one => one.isUnresolved)
  expect(record).toBeDefined()
  expect(record!.isPresent).toBe(true)
  expect(record!.isWaiting).toBe(true)
  expect(record!.isUnresolved).toBe(true)
  const view = viewOf(text, gone, ledger)
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
  const gone = goneFor(text)
  const view = viewOf(text, gone, observe(emptyQuestions(), text).ledger)
  expect(view.waiting.map(item => item.text)).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Which plan, A or B?'])
  expect(view.older[0]!.options).toEqual(['A', 'B'])
})

test('a waiting approval whose agent is alive stays in Needs you with its reply box', () => {
  const text = file(block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const view = viewOf(text, new Set(), observe(emptyQuestions(), text).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual([])
})

test('a resumed session with a live pid raises its folded question again', () => {
  const before = file(block('d4e5f6a7', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const folded = viewOf(before, goneFor(before), observe(emptyQuestions(), before).ledger)
  expect(folded.waiting.map(item => item.text)).toEqual([])
  expect(folded.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const after = file(block('d4e5f6a7', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const raised = viewOf(after, goneFor(after), observe(emptyQuestions(), after).ledger)
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
  const parsed = parseProgress(withFields)[0]!.tasks[0]!.auto!
  expect(parsed.agentPid).toBe(livePid)
  expect(parsed.agentStarted).toBe(liveStarted)
  expect(parsed.host).toBe(host)
  expect(isStopped(parsed, NOW, parsed.updated, STALE_MS, new Set())).toBe(false)
  expect(isStopped(parsed, NOW, parsed.updated, STALE_MS, new Set([blockKey(parsed)]))).toBe(true)
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
  const view = viewOf(withFields, new Set(), observe(emptyQuestions(), withFields).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual([])
})

test('the pid and host hash appear nowhere in --json output, the page model or the LAN page model', () => {
  const text = file(block('f6a7b8c9', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  expect(text).toContain(`agentpid=${deadPidValue}`)
  expect(text).toContain(`host=${host}`)
  const gone = goneFor(text)
  const settled = observe(emptyQuestions(), text).ledger
  const view = viewOf(text, gone, settled)
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
  expect(isDeadAgent({ pid: deadPidValue, started: liveStarted, host: otherHost }, host, false, null)).toBe(false)
  expect(isDeadAgent({ pid: deadPidValue, started: liveStarted, host: otherHost }, host, true, liveStarted)).toBe(false)
  const text = file(block('a7b8c9d0', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host: otherHost }))
  const view = viewOf(text, goneFor(text), observe(emptyQuestions(), text).ledger)
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
  const text = file(block('b8c9d0e1', 'codex', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const view = viewOf(text, goneFor(text), observe(emptyQuestions(), text).ledger)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
})

test('a dead-but-recent stopped row\'s confirm and archive go through with gone evidence and are refused without it', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const gone = goneFor(text)
  const view = viewOf(text, gone, observe(emptyQuestions(), text).ledger)
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row).toBeDefined()
  expect(row!.archive).not.toBe(null)
  expect(row!.confirm).not.toBe(null)
  if (row!.archive === null || row!.confirm === null) throw new Error('stopped row actions missing')
  const archived = takeTask(text, row.archive, NOW, words, {}, STALE_MS, gone)
  expect(archived).not.toBe(null)
  expect(archived?.text).not.toContain('Ship a1b2c3d4')
  const confirmed = confirmTask(text, row.confirm, NOW, words, {}, STALE_MS, gone)
  expect(confirmed?.text).toContain('state=done')
  expect(takeTask(text, row.archive, NOW, words, {}, STALE_MS)).toBe(null)
  expect(confirmTask(text, row.confirm, NOW, words, {}, STALE_MS)).toBe(null)
  const otherGone = goneFor(file(block('b2c3d4e5', 'claude', 'waiting', '- [?] Other?', { pid: deadPidValue, started: liveStarted, host })))
  expect(takeTask(text, row.archive, NOW, words, {}, STALE_MS, otherGone)).toBe(null)
  expect(confirmTask(text, row.confirm, NOW, words, {}, STALE_MS, otherGone)).toBe(null)
})

// Fable Section 3 Test 6 (death out of question list): observeQuestions is invariant to process death (byte-equal).
test('observeQuestions is invariant to process liveness: the ledger bytes never change when an agent process dies', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const projects = parseProgress(text)
  const first = observeQuestions(emptyQuestions(), projects, null, [], NOW, true, 'writer:1').ledger
  const beforeBytes = questionsJson(first)
  // Running observeQuestions again after process death produces identical ledger JSON.
  const second = observeQuestions(first, projects, null, [], NOW + 1, true, 'writer:2').ledger
  expect(questionsJson(second)).toBe(beforeBytes)
  const gone = goneFor(text)
  const view = viewOf(text, gone, second)
  expect(view.waiting).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
})

// Fable Section 3 Test 7: close, resume and close again (both plain and producer-token) keeps one record without flip-flop.
test('after close, resume and close again the stopped row names the active record for both plain and producer-token questions', () => {
  const token = `${'b'.repeat(64)}:1`
  for (const [label, step] of [
    ['plain', '- [?] Deploy the synthetic build, OK?'],
    ['token', `- [?] Deploy the synthetic build, OK?\n<!-- question=${token} -->`],
  ] as const) {
    const firstClose = file(block('a1b2c3d4', 'claude', 'waiting', step, { pid: deadPidValue, started: liveStarted, host }))
    const resumedLive = file(block('a1b2c3d4', 'claude', 'waiting', step, { pid: livePid, started: liveStarted + 5000, host }, 2))
    const secondClose = file(block('a1b2c3d4', 'claude', 'waiting', step, { pid: deadPidValue + 1, started: liveStarted + 5000, host }, 1))

    const open = observe(emptyQuestions(), firstClose).ledger
    const close1Gone = goneFor(firstClose, new Set([deadPidValue]))
    const close1View = viewOf(firstClose, close1Gone, open)
    expect(close1View.older.map(item => item.text), `${label}: first close folds`).toEqual(['Deploy the synthetic build, OK?'])

    const resumedLedger = observe(open, resumedLive).ledger
    const resumedView = viewOf(resumedLive, goneFor(resumedLive, new Set([deadPidValue])), resumedLedger)
    expect(resumedView.waiting.map(item => item.text), `${label}: resume raises`).toEqual(['Deploy the synthetic build, OK?'])

    const close2Ledger = observe(resumedLedger, secondClose).ledger
    const unresolved = close2Ledger.records.filter(one => one.isUnresolved)
    expect(unresolved, `${label}: single active record`).toHaveLength(1)
    if (label === 'token') expect(unresolved[0]!.producer).toBe(token)
    const close2Gone = goneFor(secondClose, new Set([deadPidValue + 1]))
    const close2View = viewOf(secondClose, close2Gone, close2Ledger)
    expect(rowOf(close2View, 'Ship a1b2c3d4')?.questions?.map(question => question.questionId)).toEqual([unresolved[0]!.id])
    expect(close2View.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
    expect(close2View.waiting).toEqual([])
  }
})

// Fable Section 3 Test 8: never-observed reaches Older; already-answered / hidden stays off both Waiting and Older.
test('a never-observed gone session reaches Older unanswered, and an already-answered or hidden question asks nothing again', () => {
  const waitingText = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const gone = goneFor(waitingText)
  // Never-observed: buildView runs observeQuestions on the empty ledger, folding directly into Older.
  const neverObservedView = viewOf(waitingText, gone, emptyQuestions())
  expect(neverObservedView.waiting).toEqual([])
  expect(neverObservedView.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const createdId = neverObservedView.older[0]!.questionId!
  expect(createdId.startsWith('question:')).toBe(true)
  expect(rowOf(neverObservedView, 'Ship a1b2c3d4')?.questions?.map(q => q.questionId)).toEqual([createdId])

  // Already answered (resolved in ledger): stays off Waiting and Older.
  const ledger = observe(emptyQuestions(), waitingText).ledger
  const resolved = resolveQuestion(ledger, ledger.records[0]!.id, NOW + 1)
  const resolvedView = viewOf(waitingText, gone, resolved)
  expect(resolvedView.waiting).toEqual([])
  expect(resolvedView.older).toEqual([])

  // Hidden before close: stays in hidden, off Waiting and Older.
  const hiddenView = viewOf(waitingText, gone, ledger, [ledger.records[0]!.id])
  expect(hiddenView.waiting).toEqual([])
  expect(hiddenView.older).toEqual([])
  expect(hiddenView.hidden.map(item => item.hideKey)).toEqual([ledger.records[0]!.id])

  // Ticked after close: resolves normally, stays off Waiting and Older.
  const tickedText = file(block('a1b2c3d4', 'claude', 'waiting', '- [x] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const tickedLedger = observe(ledger, tickedText).ledger
  expect(tickedLedger.records[0]!.isUnresolved).toBe(false)
  const tickedView = viewOf(tickedText, goneFor(tickedText), tickedLedger)
  expect(tickedView.waiting).toEqual([])
  expect(tickedView.older).toEqual([])
})

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
  const restamped = withAgentIdentity(stamped, { pid: 5678, host })
  expect(restamped.agentPid).toBe(5678)
  expect(restamped.agentStarted).toBeUndefined()
  expect(restamped.host).toBe(host)
})

// Fable Section 3 Test 3 + short-id isolation: claim-less newest (e.g. 0.24.3 rewrite) + older dead duplicate + short-id peer.
test('a dead session sharing a short id, an older dead duplicate, or a claim-less newest rewrite never folds the live session', () => {
  const liveResume = '1111111111111111111111111111111111111111111111111111111111111111'
  const deadResume = '2222222222222222222222222222222222222222222222222222222222222222'
  const text = file(
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }, 5, liveResume),
    block('a1b2c3d4', 'claude', 'waiting', '- [?] Which plan, A or B?', { pid: deadPidValue, started: liveStarted, host }, 5, deadResume),
  )
  const projects = parseProgress(text)
  const gone = goneBlocks(projects, claim => ({ alive: claim.pid !== deadPidValue, actual: null }), host)
  expect([...gone]).toEqual([blockKey(projects[0]!.tasks[1]!.auto!)])
  const settled = observe(emptyQuestions(), text).ledger
  const view = viewOf(text, gone, settled)
  expect(view.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(view.older.map(item => item.text)).toEqual(['Which plan, A or B?'])

  // Claim-less newest duplicate (such as a 0.24.3 board rewrite) beside an older dead duplicate:
  // `gone` holds only the older dead block's key; the folded winner has no claim, so it stays waiting.
  const twinClaimLessNewest = file(
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }, 9, liveResume),
    block('c3d4e5f6', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', null, 5, liveResume),
  )
  const twinProjects = parseProgress(twinClaimLessNewest)
  expect(claimedBlocksOf(twinProjects, host).map(one => one.key)).toEqual([blockKey(twinProjects[0]!.tasks[0]!.auto!)])
  const twinGone = goneBlocks(twinProjects, claim => ({ alive: claim.pid !== deadPidValue, actual: null }), host)
  expect([...twinGone]).toEqual([blockKey(twinProjects[0]!.tasks[0]!.auto!)])
  const twinView = viewOf(twinClaimLessNewest, twinGone, observe(emptyQuestions(), twinClaimLessNewest).ledger)
  expect(twinView.waiting.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(twinView.older).toEqual([])
})

// Fable Section 3 Test 9
test('the pid and host hash appear nowhere in a record source, a stored mirror or a completion overlay', () => {
  const text = file(block('f6a7b8c9', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const task = parseProgress(text)[0]!.tasks[0]!
  expect(sourceData(task)).not.toContain(String(deadPidValue))
  expect(sourceData(task)).not.toContain(host)
  const mirror: ProgressMirror = { ...emptyMirror('a1b2c3d4-person-a', 'demo', NOW, '', 'claude'), agentPid: livePid, agentStarted: liveStarted, host }
  expect(JSON.stringify(withoutProcessIdentity(mirror))).not.toContain(String(livePid))
  expect(JSON.stringify(withoutProcessIdentity(mirror))).not.toContain(host)
  const overlay = completionOverlay('agent:a1b2c3d4', mirror, NOW)
  expect(JSON.stringify(overlay.completed)).not.toContain(String(livePid))
  expect(JSON.stringify(overlay.completed)).not.toContain(host)
})

// Fable Section 3 Test 10: plugin and board script read the exact same ledger without flip-flop.
test('the plugin settling a question and the board script reading it share the same ledger without flip-flop', () => {
  const text = file(block('a1b2c3d4', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: deadPidValue, started: liveStarted, host }))
  const projects = parseProgress(text)
  const pluginGone = goneBlocks(projects, claim => ({ alive: claim.pid !== deadPidValue, actual: null }), host)
  expect([...pluginGone]).toEqual([blockKey(projects[0]!.tasks[0]!.auto!)])
  const first = observe(emptyQuestions(), text).ledger
  const reread = observe(first, text).ledger
  expect(questionsJson(reread)).toBe(questionsJson(first))
  expect(reread.records).toHaveLength(1)
  const view = viewOf(text, pluginGone, reread)
  expect(view.waiting).toEqual([])
  expect(view.older.map(item => item.text)).toEqual(['Deploy the synthetic build, OK?'])
  const row = rowOf(view, 'Ship a1b2c3d4')
  expect(row?.questions?.map(question => question.questionId)).toEqual([reread.records[0]!.id])
})

// Fable Section 3 Test 13
test('a 0.24.3-era board reads a block with the new fields, and the new board reads an old block unchanged', () => {
  const withFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', { pid: livePid, started: liveStarted, host }))
  const old = parseProgress0243(withFields)[0]!.tasks[0]!
  expect(old.auto?.session).toBe('e5f6a7b8')
  expect(old.auto?.agent).toBe('claude')
  expect(old.auto?.state).toBe('waiting')
  expect(old.steps.map(step => step.text)).toEqual(['Deploy the synthetic build, OK?'])
  expect(old.steps[0]!.status).toBe('waiting')
  expect(old.auto?.agentPid).toBeUndefined()
  expect(old.auto?.agentStarted).toBeUndefined()
  expect(old.auto?.host).toBeUndefined()
  const withoutFields = file(block('e5f6a7b8', 'claude', 'waiting', '- [?] Deploy the synthetic build, OK?', null))
  const oldBlock = parseProgress(withoutFields)[0]!.tasks[0]!.auto
  expect(oldBlock?.agentPid).toBeUndefined()
  expect(oldBlock?.agentStarted).toBeUndefined()
  expect(oldBlock?.host).toBeUndefined()
})

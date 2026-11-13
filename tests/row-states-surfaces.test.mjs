import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const loadSources = async () => {
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(new URL('../hooks/', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      return nextResolve(specifier, context)
    },
  })
  try {
    return await Promise.all([
      import('../hooks/parse.ts'),
      import('../hooks/view.ts'),
      import('../hooks/serve.ts'),
      import('../hooks/board.ts'),
      import('../hooks/board-status.ts'),
      import('../hooks/board-json.ts'),
      import('../hooks/strings.ts'),
      import('../hooks/messaging.ts'),
      import('../hooks/hook-messages.ts'),
    ])
  } finally { loader.deregister() }
}

const [{ parseProgress, STALE_MS }, { buildView }, { serveModel, servePage }, { boardText }, { boardStatus, boardCounts }, { boardDocument }, { STRINGS }, { queueMessage }, { mailboxId }] = await loadSources()
const EN = STRINGS.en
const NOW = Date.parse('2026-11-04T12:00:00Z')
const MINUTE = 60_000

// One fixture file fed to all four surfaces: the page (serveModel), the
// terminal board (boardText), --status (boardStatus) and --json
// (boardDocument). The counts must agree on every case (#1317). The queued
// case also re-verifies #1296: it records what the four surfaces do with a
// queued answer, and does not claim #1296 fixed.
const block = (id, agent, state, title, steps, at = NOW, extra = '') =>
  `<!-- auto session=${id} agent=${agent} state=${state} updated=${new Date(at).toISOString()} ${extra} -->\n### ${title}\n${steps}\n<!-- /auto session=${id} -->\n`
const groupOptions = { now: NOW, repoOf: () => null, versions: { board: '', package: null }, unreadable: [] }
const surfaces = (file, { messaging, pending = [], staleMs = STALE_MS } = {}) => {
  const view = buildView(parseProgress(file), [], null, NOW, 0, {}, EN, [], {}, undefined, undefined, [], new Set(), undefined, staleMs)
  const page = serveModel(view, pending, EN, new Set(), false, messaging, false, groupOptions)
  const terminal = boardText(view, pending, EN, { width: 100, isColor: false, messaging })
  const status = boardStatus(file, NOW, EN, staleMs, '', '', pending, messaging)
  const json = boardDocument(view, pending, [], EN, '/synthetic-home', false, NOW, groupOptions, undefined, messaging)
  return { view, page, terminal, status, json }
}
// The page's Needs-you number is its grouped count minus the answers already
// held for the next turn; the other three surfaces already leave those out.
const pageNeeds = page => page.view.n - page.view.needs.handled.length
const statusCounts = status => {
  const match = /^(\d+) need you · (\d+) working(?: · (\d+) queued)?$/.exec(status.trim())
  assert.ok(match, `not a status line: ${status}`)
  return { needs: Number(match[1]), working: Number(match[2]), queued: Number(match[3] ?? 0) }
}
const terminalCounts = terminal => {
  const line = terminal.split('\n')[0]
  const needs = /● (\d+) waiting/.exec(line)?.[1]
  const working = /▸ (\d+) in progress/.exec(line)?.[1]
  const queued = /◌ (\d+) queued/.exec(line)?.[1]
  assert.ok(needs !== undefined && working !== undefined, `not a count line: ${line}`)
  return { needs: Number(needs), working: Number(working), queued: Number(queued ?? 0) }
}
const agree = (name, { page, terminal, status, json }) => {
  assert.equal(pageNeeds(page), statusCounts(status).needs, `${name}: page needs must match --status`)
  assert.equal(terminalCounts(terminal).needs, statusCounts(status).needs, `${name}: terminal needs must match --status`)
  assert.equal(json.counts.needs, statusCounts(status).needs, `${name}: --json needs must match --status`)
  assert.equal(page.view.working.length, statusCounts(status).working, `${name}: page working must match --status`)
  assert.equal(terminalCounts(terminal).working, statusCounts(status).working, `${name}: terminal working must match --status`)
  assert.equal(json.counts.working, statusCounts(status).working, `${name}: --json working must match --status`)
  assert.equal(page.view.needs.handled.length, json.counts.queued, `${name}: page queued must match --json`)
  assert.equal(terminalCounts(terminal).queued, json.counts.queued, `${name}: terminal queued must match --json`)
  assert.equal(statusCounts(status).queued, json.counts.queued, `${name}: --status queued must match --json`)
}

test('one fixture, four surfaces: a plain waiting question and a working row agree', () => {
  const file = '## synthetic-api\n' +
    block('a1000001', 'codex', 'waiting', 'Choose the limit', '- [?] Limit — 100 or 300 a minute?', NOW - MINUTE) +
    block('a1000002', 'codex', 'working', 'Write a test', '- [~] Write a test', NOW - MINUTE) +
    block('a1000003', 'codex', 'done', 'Fixed the links', '- [x] Checked every link', NOW - 10 * MINUTE)
  const out = surfaces(file)
  agree('plain waiting', out)
  assert.equal(statusCounts(out.status).needs, 1)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.page.counts.waiting, 1, 'with no inbox turns the page count and the grouped count agree')
  assert.equal(out.json.counts.questions, 1)
  assert.equal(out.json.counts.stuck, 0)
  assert.equal(out.json.counts.queued, 0)
})

test('one fixture, four surfaces: an answer queued for the next turn leaves Needs you everywhere (#1296)', async () => {
  const session = '11111111-2222-4333-8444-555555555555'
  const box = { id: mailboxId('codex', session), agent: 'codex', session, surface: 'synthetic', turn: 'session', scope: 'mailbox', expires: NOW + 3_600_000 }
  const queued = queueMessage({ messages: [], mailboxes: [box] }, { id: 'SYNTHETIC-QUEUED-1', text: 'Yes', target: box.id, turn: 'session' }, 'board', box, NOW)
  const messaging = { connections: [box], mailboxes: [box], messages: queued.state.messages }
  const file = '## synthetic-api\n' +
    block('a1000001', 'codex', 'waiting', 'First choice?', '- [?] First choice?', NOW - 5 * MINUTE, `resume=${session}`) +
    block('a1000002', 'claude', 'waiting', 'Continue, OK?', '- [?] Continue, OK?', NOW - 10 * MINUTE)
  // Without the queued answer both questions wait: needs 2 on every surface.
  const unqueued = surfaces(file)
  agree('unqueued', unqueued)
  assert.equal(statusCounts(unqueued.status).needs, 2)
  assert.equal(unqueued.json.counts.queued, 0)
  // With it, the queued question leaves Needs you on every surface, and is
  // listed under queued on every surface — the #1296 shape, re-verified here
  // on one fixture. The issue itself stays open: this fixture shows the four
  // surfaces agreeing, not that every queued shape does.
  const out = surfaces(file, { messaging })
  agree('queued answer', out)
  assert.equal(statusCounts(out.status).needs, 1)
  assert.equal(statusCounts(out.status).queued, 1)
  assert.equal(out.page.view.n, 2, 'the page groups both cards before leaving the held one out')
  assert.equal(out.page.view.needs.handled.length, 1)
  assert.ok(out.terminal.includes('◌ 1 queued'), `terminal must mark the queued answer:\n${out.terminal}`)
  assert.ok(out.status.includes('· 1 queued'), `status must mark the queued answer: ${out.status}`)
  assert.equal(out.json.counts.queued, 1)
  assert.equal(out.json.queued[0].text, 'First choice?')
  assert.equal(out.json.needs[0].text, 'Continue, OK?')
})

test('one fixture, four surfaces: an unsure row counts in no number anywhere (#1317)', () => {
  const file = '## synthetic-api\n' +
    block('a1000001', 'antigravity', 'waiting', 'Closed window work', '- [ ] Waiting for the next instruction', NOW - 31 * MINUTE) +
    block('a1000002', 'codex', 'working', 'Write a test', '- [~] Write a test', NOW - MINUTE)
  const out = surfaces(file)
  agree('unsure row', out)
  assert.equal(statusCounts(out.status).needs, 0)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.page.view.unsure.length, 1)
  const pageRow = out.page.groups.flatMap(group => group.rows).find(row => row.title === 'Closed window work')
  assert.equal(pageRow.status, EN.rowUnsure(EN.minutesAgo(31)))
  assert.equal(pageRow.rowState, 'unsure')
  assert.ok(out.terminal.includes(EN.rowUnsure(EN.minutesAgo(31))), `terminal must show the unsure row with its age:\n${out.terminal}`)
  const jsonRow = out.json.waiting.find(one => one.title === 'Closed window work')
  assert.equal(jsonRow.state, 'unsure')
  assert.equal(jsonRow.isUnsure, true)
  assert.equal(jsonRow.age, '31 min ago')
  assert.equal(out.json.counts.waiting, 1, 'the unsure row stays on its shelf in --json')
})

test('one fixture, four surfaces: an ended row sits on the stopped shelf everywhere', () => {
  const file = '## synthetic-api\n' +
    block('a1000001', 'cursor', 'ended', 'Stopped investigation', '- [ ] Read the next log', NOW - 2 * 60 * MINUTE) +
    block('a1000002', 'codex', 'working', 'Write a test', '- [~] Write a test', NOW - MINUTE)
  const out = surfaces(file)
  agree('ended row', out)
  assert.equal(statusCounts(out.status).needs, 0)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.json.counts.stopped, 1)
  assert.equal(out.json.stopped[0].title, 'Stopped investigation')
  assert.equal(out.json.stopped[0].state, 'ended')
  assert.equal(out.page.view.all.stopped.length, 1)
  assert.ok(out.terminal.includes(EN.stoppedCount(1)), `terminal must count the stopped row:\n${out.terminal}`)
})

test('one fixture, four surfaces: a stale working row sits on the stopped shelf everywhere', () => {
  const file = '## synthetic-api\n' +
    block('a1000001', 'codex', 'working', 'Stale work', '- [~] Write a test', NOW - 13 * 60 * MINUTE) +
    block('a1000002', 'codex', 'working', 'Fresh work', '- [~] Write a test', NOW - MINUTE)
  const out = surfaces(file)
  agree('stopped shelf', out)
  assert.equal(statusCounts(out.status).needs, 0)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.json.counts.stopped, 1)
  assert.equal(out.json.stopped[0].title, 'Stale work')
  assert.equal(out.json.stopped[0].state, 'ended', 'the 12 h backstop reads ended, as today')
  assert.equal(out.page.view.all.stopped.length, 1)
})

test('one fixture, four surfaces: a custom stale timeout ends the row on every surface (#1317)', () => {
  // Greptile P1 on #1406: --stale-ms 60000 must end a two-minute-old working
  // row in --json too, not only in --status and on the Stopped shelf.
  const file = '## synthetic-api\n' +
    block('a1000001', 'codex', 'working', 'Stale work', '- [~] Write a test', NOW - 2 * MINUTE) +
    block('a1000002', 'codex', 'working', 'Fresh work', '- [~] Write a test', NOW - MINUTE)
  const out = surfaces(file, { staleMs: MINUTE })
  agree('custom stale timeout', out)
  assert.equal(statusCounts(out.status).needs, 0)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.json.counts.stopped, 1)
  assert.equal(out.json.stopped[0].title, 'Stale work')
  assert.equal(out.json.stopped[0].state, 'ended', 'the configured timeout, not 12 h, ends the row in --json')
  assert.equal(out.page.view.all.stopped.length, 1)
})

test('one fixture, four surfaces: a working placeholder row quiet past 30 min keeps the stopped wording on the page (#1317)', () => {
  // Greptile P2 on #1406: the row derives 'unsure' but its effective state is
  // 'ended' (silence), so the page must not add the grey unsure label on the
  // Stopped shelf — the terminal already keeps the stopped wording there.
  // The label is drawn by the page's own script, so the test reads the served
  // page as well as the model.
  const file = '## synthetic-api\n' +
    block('a1000001', 'antigravity', 'working', 'Silent window work', '- [ ] Waiting for the next instruction', NOW - 31 * MINUTE) +
    block('a1000002', 'codex', 'working', 'Write a test', '- [~] Write a test', NOW - MINUTE)
  const out = surfaces(file)
  agree('working placeholder silence', out)
  assert.equal(statusCounts(out.status).needs, 0)
  assert.equal(statusCounts(out.status).working, 1)
  assert.equal(out.page.view.all.stopped.length, 1)
  const pageRow = out.page.stopped.find(row => row.title === 'Silent window work')
  assert.equal(pageRow.rowState, 'unsure')
  assert.equal(pageRow.auto, 'ended')
  assert.equal(pageRow.status, EN.sessionStopped(EN.minutesAgo(31)), 'the model keeps the stopped wording for this row')
  assert.ok(!out.terminal.includes(EN.rowUnsure(EN.minutesAgo(31))), `terminal must not show the unsure wording here:\n${out.terminal}`)
  assert.ok(out.terminal.includes(EN.stoppedCount(1)), `terminal must count the stopped row:\n${out.terminal}`)
  assert.equal(out.json.counts.stopped, 1)
  assert.equal(out.json.stopped[0].state, 'unsure', 'the derivation is still unsure; only the page label is guarded')
  assert.ok(servePage(EN, 'synthetic').includes(`var isUnsureRow = row.rowState === 'unsure' && row.auto !== 'ended';`), 'the served page must guard the unsure label with the ended state')
})

test('the page model carries no approval count, so only the tab title can add approvals (Q7, undecided)', () => {
  // A pending approval lives in the page server's live state
  // (scripts/board-serve.ts), not in the progress file, so no fixture can
  // stage one for all four surfaces — and the model the four surfaces share
  // has no approvals field for it. The tab title adds
  // approvalsWaiting(latestApprovals) (hooks/serve.ts) while the flag,
  // --status, --json and the terminal count none. Whether that is a bug or
  // intended is DESIGN.md Q7, for the owner/PM — this test pins the measured
  // asymmetry rather than agreeing a number.
  const file = '## synthetic-api\n' +
    block('a1000001', 'codex', 'waiting', 'Choose the limit', '- [?] Limit — 100 or 300 a minute?', NOW - MINUTE)
  const out = surfaces(file)
  assert.equal('approvals' in out.page.view, false)
  assert.deepEqual(Object.keys(boardCounts(out.view, [], EN, NOW)).sort(), ['needs', 'queued', 'working'])
  assert.equal('approvals' in out.json.counts, false)
  assert.equal(statusCounts(out.status).needs, 1)
})

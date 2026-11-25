// #1843 PR-2a (plan-0.26.0.md B4): one status line for a message, read from its stored receipt, in the same words on
// the terminal board, --print and --json. The owner's answers on #1843 (7177103649, "All (a)"): one set of words for
// every agent; a claim reads Queued for 20 s after its last event, then Unsure; only a route that goes in now has that
// clock; a delivered message whose holder went away reads Unsure; Answered and Read need no store change; --json adds
// an optional `message` field and keeps schema version 1.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(new URL('../', import.meta.url).href) && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
let status, delivery, store, hooks, board, boardJson, view, parse, strings, bundle
try {
  // Before this change the module does not exist: every test here then fails on its own assertion or call.
  status = await import('../hooks/message-status.ts').catch(() => ({}))
  ;[delivery, store, hooks, board, boardJson, view, parse, strings, bundle] = await Promise.all([
    import('../hooks/delivery-states.ts'), import('../hooks/queued-store.ts'), import('../hooks/hook-messages.ts'), import('../hooks/board.ts'), import('../hooks/board-json.ts'),
    import('../hooks/view.ts'), import('../hooks/parse.ts'), import('../hooks/strings.ts'), import('../hooks/board-script.ts'),
  ])
} finally { loader.deregister() }
const { MESSAGE_STATES, NOW_ROUTE_MS, messageStatus } = status
const { DELIVERY_STATES, SAMPLE_NOW, sampleOf, shapesOf } = delivery
const { shownMessages } = store
const { STRINGS } = strings

const en = STRINGS.en
const SECOND = 1000
const MINUTE = 60 * SECOND
const NOW = SAMPLE_NOW
// A stored message as anyone but its receiver sees it (the board script reads it so), from the delivery table's samples.
const shown = (name, shape) => shownMessages(sampleOf(name, shape).state)[0]
const at = (one, fields) => ({ ...one, ...fields })
const statusOf = (one, now = NOW, s = en, reportedAt) => messageStatus(one, now, s, reportedAt)
const shapeNames = name => [undefined, ...Object.keys(shapesOf(name))]

test('a queued message reads Queued with when it goes in, the same words for every agent', () => {
  for (const agent of ['claude', 'codex', 'antigravity', 'opencode', 'deepseek']) {
    const one = at(shown('queued'), { to: `${agent}:s1` })
    assert.deepEqual(statusOf(one), { state: 'queued', line: 'Queued · now', tone: 'wait', updatedAt: NOW }, agent)
  }
  assert.equal(statusOf(shown('queued'), NOW, STRINGS['zh-TW']).line, '已排入 · 馬上')
  assert.equal(statusOf(shown('queued'), NOW, STRINGS['zh-CN']).line, '已排入 · 马上')
})

test('a step-end or next-turn message has no clock: it reads Queued with what it waits for and its age', () => {
  const waits = [
    [at(shown('queued'), { line: 'stepEnd' }), 'when its step ends'],
    [shown('queuedForHook'), 'at its next turn'],
    [at(shown('queuedForHook'), { line: 'nextTurn' }), 'at its next turn'],
    [shown('queuedForWake'), 'at its next turn'],
    [at(shown('queued'), { line: 'afterWait' }), 'when its wait ends'],
    [at(shown('queued'), { line: 'chatOpen' }), 'when its chat next opens'],
    [at(shown('queued'), { line: 'reopen' }), 'once the app quits'],
  ]
  for (const [one, when] of waits) {
    assert.deepEqual(statusOf(one, NOW + 20 * SECOND), { state: 'queued', line: `Queued · ${when} · ${en.justNow}`, tone: 'wait', updatedAt: NOW }, when)
    assert.equal(statusOf(one, NOW + 10 * MINUTE).line, `Queued · ${when} · ${en.minutesAgo(10)}`, when)
  }
})

test('a now-route message with no event for 20 s reads Unsure, and reading it changes nothing', () => {
  assert.equal(NOW_ROUTE_MS, 20 * SECOND)
  for (const one of [shown('queued'), at(shown('queued'), { line: 'now' })]) {
    const before = structuredClone(one)
    assert.equal(statusOf(one, NOW + NOW_ROUTE_MS - 1).state, 'queued')
    assert.deepEqual(statusOf(one, NOW + NOW_ROUTE_MS), { state: 'unsure', line: 'Unsure · no answer · check its window', tone: 'alert', updatedAt: NOW })
    assert.deepEqual(one, before)
  }
})

test('a fresh claim reads Queued for 20 s after its last event, then Unsure, without a live connection', () => {
  for (const name of ['claimed', 'pulled', 'leased', 'leaseSpent', 'wakeClaimed', 'wakeStarted']) {
    assert.deepEqual(statusOf(shown(name), NOW + NOW_ROUTE_MS - 1), { state: 'queued', line: 'Queued · now', tone: 'wait', updatedAt: NOW }, name)
    assert.deepEqual(statusOf(shown(name), NOW + NOW_ROUTE_MS), { state: 'unsure', line: 'Unsure · no answer · check its window', tone: 'alert', updatedAt: NOW }, name)
  }
  // The 20 s count from the last event: a claim stored later is fresh again.
  assert.equal(statusOf(at(shown('claimed'), { updated: NOW + MINUTE, claimed: NOW + MINUTE }), NOW + MINUTE + 5 * SECOND).state, 'queued')
})

test('a message that read Unsure at 20 s reads Delivered once its acceptance arrives', () => {
  const claim = shown('claimed')
  assert.equal(statusOf(claim, NOW + 30 * SECOND).state, 'unsure')
  const accepted = at(claim, { status: 'accepted', updated: NOW + 31 * SECOND })
  assert.deepEqual(statusOf(accepted, NOW + 32 * SECOND), { state: 'delivered', line: `Delivered · ${en.justNow}`, tone: 'done', updatedAt: NOW + 31 * SECOND })
})

test('a message reads Delivered only from an acceptance on record', () => {
  for (const name of ['accepted', 'handed', 'acceptedAwaitsAck', 'wakeAccepted']) {
    assert.deepEqual(statusOf(shown(name), NOW + 5 * MINUTE), { state: 'delivered', line: `Delivered · ${en.minutesAgo(5)}`, tone: 'done', updatedAt: NOW }, name)
  }
  for (const name of ['claimed', 'pulled', 'leased', 'leaseSpent', 'wakeClaimed', 'wakeStarted']) {
    for (const later of [0, NOW_ROUTE_MS, 10 * MINUTE]) assert.notEqual(statusOf(shown(name), NOW + later).state, 'delivered', `${name} +${later}`)
  }
})

test('an ACK reads Read with its reply and no ACK code, and never Answered by itself', () => {
  assert.deepEqual(statusOf(shown('acknowledged'), NOW + MINUTE), { state: 'read', line: 'Read', tone: 'done', updatedAt: NOW })
  assert.equal(statusOf(shown('acknowledged', 'withReply'), NOW + MINUTE).line, 'Read · on it')
  // A receipt kept from a version 1 store was acknowledged with the message id.
  assert.equal(statusOf(at(shown('acknowledged'), { reply: 'ACK m1 done' }), NOW + MINUTE).line, 'Read · done')
  assert.equal(statusOf(shown('acknowledged', 'withReply'), NOW + MINUTE, STRINGS['zh-TW']).line, '已讀 · on it')
  const answer = at(shown('acknowledged', 'withReply'), { answers: 'q1' })
  assert.equal(statusOf(answer, NOW + MINUTE).state, 'read')
  assert.equal(statusOf(answer, NOW + MINUTE, en, NOW).state, 'read')
})

test('an answer reads Answered once it was handed over and its session reported since', () => {
  for (const name of ['accepted', 'handed', 'acknowledged', 'acceptedLost']) {
    const one = at(shown(name), { answers: 'q1' })
    assert.notEqual(statusOf(one, NOW + MINUTE, en, NOW).state, 'answered', name)
    assert.deepEqual(statusOf(one, NOW + MINUTE, en, NOW + 1), { state: 'answered', line: 'Answered · on the board', tone: 'done', updatedAt: NOW }, name)
  }
  assert.equal(statusOf(at(shown('accepted'), { answers: 'q1' }), NOW + MINUTE, STRINGS['zh-TW'], NOW + 1).line, '已回覆 · 在看板上')
  // A message that answers no question, and an answer never handed over, do not read Answered.
  assert.equal(statusOf(shown('accepted'), NOW + MINUTE, en, NOW + 1).state, 'delivered')
  for (const name of ['queued', 'queuedForHook', 'claimed', 'leased', 'rejected', 'holderLost', 'disconnected']) {
    assert.notEqual(statusOf(at(shown(name), { answers: 'q1' }), NOW + MINUTE, en, NOW + 1).state, 'answered', name)
  }
})

test('a delivered message whose holder went away reads Unsure, delivered with no reply confirmed', () => {
  const unsure = { state: 'unsure', line: 'Unsure · delivered, reply not confirmed · check its window', tone: 'alert', updatedAt: NOW }
  const lost = [['acceptedLost'], ['acceptedLost', 'otherError'], ['acceptedLost', 'awaitsAck'], ['acceptedLost', 'onWake'], ['handedLost'], ['handedLost', 'onPull'], ['handedLost', 'onWake'],
    ['wakeExpired'], ['claimed', 'acceptedBefore'], ['queued', 'acceptedBefore'], ['leased', 'acceptedBefore'], ['inDoubt', 'acceptedBefore'], ['disconnected', 'acceptedBefore'], ['expired', 'acceptedBefore']]
  for (const [name, shape] of lost) {
    assert.deepEqual(statusOf(shown(name, shape), NOW + 10 * MINUTE), unsure, `${name}.${shape}`)
    assert.notEqual(statusOf(shown(name, shape), NOW).state, 'queued', `${name}.${shape}`)
  }
})

test('every uncertain receipt reads Unsure with one reason', () => {
  const lines = {
    disconnected: 'connection lost',
    inDoubt: 'timed out',
    turnEnded: 'its turn stopped',
    restarted: 'the board restarted',
    holderLost: 'nobody took it',
    unconfirmed: 'sent, not confirmed',
    expired: 'waited too long',
  }
  for (const [name, why] of Object.entries(lines)) {
    assert.deepEqual(statusOf(shown(name), NOW + MINUTE), { state: 'unsure', line: `Unsure · ${why} · check its window`, tone: 'alert', updatedAt: NOW }, name)
  }
  assert.equal(statusOf(shown('inDoubt', 'otherError'), NOW + MINUTE).line, 'Unsure · connection lost · check its window')
  for (const error of ['TURN_NOT_COMPLETED', 'TURN_STATUS_UNKNOWN', 'ACK_MISSING', 'ACK_REQUIRED', 'NATIVE_TURN_FAILED']) {
    assert.equal(statusOf(at(shown('turnEnded'), { error }), NOW + MINUTE).line, 'Unsure · its turn stopped · check its window', error)
  }
  assert.equal(statusOf(at(shown('inDoubt'), { error: 'SOMETHING_ELSE' }), NOW + MINUTE).line, 'Unsure · no answer · check its window')
  assert.equal(statusOf(shown('holderLost'), NOW + MINUTE, STRINGS['zh-TW']).line, '不確定 · 沒有人接手 · 看它的視窗')
})

test('every refused, stopped, withdrawn or unreachable message reads Not delivered with its reason', () => {
  const lines = [
    [shown('rejected'), 'refused'],
    [shown('rejected', 'stopped'), 'stopped'],
    [shown('takenBack'), 'taken back'],
    [shown('takenBack', 'onHook'), 'taken back'],
    [shown('queuedForHook', 'otherSurface'), 'its session no longer reads here'],
    [shown('queuedForWake', 'otherSurface'), 'its session no longer reads here'],
    [at(shown('queued'), { status: 'rejected', error: 'APP_STILL_OPEN' }), 'the app stayed open'],
    // Given up at the open limit before anything took it: it never left the board.
    [at(shown('queued'), { status: 'uncertain', error: 'EXPIRED' }), 'held too long'],
  ]
  for (const [one, why] of lines) assert.deepEqual(statusOf(one, NOW + MINUTE), { state: 'notDelivered', line: `Not delivered · ${why}`, tone: 'alert', updatedAt: NOW }, why)
  assert.equal(statusOf(shown('rejected'), NOW + MINUTE, STRINGS['zh-TW']).line, '未送達 · 被拒絕')
})

test('a message dismissed after it was handed out shows no line', () => {
  for (const shape of shapeNames('dismissed')) assert.equal(statusOf(shown('dismissed', shape), NOW + MINUTE), null, String(shape))
})

// The status each delivery state reads, with the shapes that read otherwise.
const EXPECTED = {
  queued: 'queued', queuedForHook: 'queued', queuedForWake: 'queued',
  claimed: 'queued', pulled: 'queued', leased: 'queued', leaseSpent: 'queued', wakeClaimed: 'queued', wakeStarted: 'queued',
  accepted: 'delivered', handed: 'delivered', acceptedAwaitsAck: 'delivered', wakeAccepted: 'delivered',
  acceptedLost: 'unsure', handedLost: 'unsure', turnEnded: 'unsure', inDoubt: 'unsure', disconnected: 'unsure', restarted: 'unsure', holderLost: 'unsure', unconfirmed: 'unsure',
  acknowledged: 'read', rejected: 'notDelivered', takenBack: 'notDelivered', dismissed: null, expired: 'unsure', wakeExpired: 'unsure',
}
const OTHERWISE = {
  'queued.acceptedBefore': 'unsure', 'queuedForHook.acceptedBefore': 'unsure', 'queuedForWake.acceptedBefore': 'unsure',
  'claimed.acceptedBefore': 'unsure', 'pulled.acceptedBefore': 'unsure', 'leased.acceptedBefore': 'unsure', 'leaseSpent.acceptedBefore': 'unsure',
  'wakeClaimed.acceptedBefore': 'unsure', 'wakeStarted.acceptedBefore': 'unsure',
  'queuedForHook.otherSurface': 'notDelivered', 'queuedForWake.otherSurface': 'notDelivered',
}
// A shape may join several (`acceptedBefore+otherSurface`): one taken before reads Unsure whatever else it has.
const expectedOf = (name, shape) => {
  const read = String(shape).split('+').map(part => OTHERWISE[`${name}.${part}`]).filter(one => one !== undefined)
  return read.includes('unsure') ? 'unsure' : read[0] ?? EXPECTED[name]
}

test('every delivery state and shape reads one of the seven states', () => {
  assert.deepEqual([...MESSAGE_STATES], ['sending', 'queued', 'delivered', 'read', 'answered', 'unsure', 'notDelivered'])
  assert.deepEqual(Object.keys(EXPECTED), [...DELIVERY_STATES])
  const wrong = []
  for (const name of DELIVERY_STATES) {
    for (const shape of shapeNames(name)) {
      const read = statusOf(shown(name, shape))
      if ((read?.state ?? null) !== expectedOf(name, shape)) wrong.push(`${name}.${shape}: ${read?.state ?? null}, not ${expectedOf(name, shape)}`)
      // The line names no message id, ACK code or path, in any language.
      for (const s of Object.values(STRINGS)) {
        const line = statusOf(shown(name, shape), NOW, s)?.line
        if (line !== undefined && (line === '' || /\bm1\b|a1b2c3|mailbox_|[\\/]/.test(line))) wrong.push(`${name}.${shape} (${s.lang}): ${line}`)
      }
    }
  }
  assert.deepEqual(wrong, [])
})

// The surfaces: a board with one working row for each agent the samples use, each row bound to session `synthetic-s1`.
const SESSION = 'synthetic-s1'
const BLOCK_AT = NOW - MINUTE
const blockOf = (id, agent, title) => `<!-- auto session=${id} agent=${agent} resume=${SESSION} state=working updated=${new Date(BLOCK_AT).toISOString()} -->
### ${title}
- [x] Opened the fixture
- [~] Compare the outputs
<!-- /auto session=${id} -->
`
const SOURCE = `## synthetic-api
${blockOf('b1000001', 'codex', 'Check the codex route')}
${blockOf('b1000002', 'opencode', 'Check the opencode route')}
${blockOf('b1000003', 'deepseek', 'Check the deepseek route')}
`
const TITLES = { codex: 'Check the codex route', opencode: 'Check the opencode route', deepseek: 'Check the deepseek route' }
const viewAt = (now = NOW, source = SOURCE, s = en) => view.buildView(parse.parseProgress(source), [], null, now, 0, {}, s)
const group = now => ({ now, repoOf: () => null, versions: { board: 'synthetic', package: null }, unreadable: [] })
// The messaging the board script reads, with the samples' session (and its mailbox) renamed to the rows' own.
const messagingOf = (name, shape, fields = {}) => {
  const { state } = sampleOf(name, shape)
  const renamed = new Map((state.mailboxes ?? []).map(one => [one.id, hooks.mailboxId(one.agent, SESSION)]))
  const messages = shownMessages(state).map(one => ({ ...one, to: one.to.replace(/:s1$/, `:${SESSION}`), target: renamed.get(one.target) ?? one.target, ...fields }))
  return { connections: [], mailboxes: (state.mailboxes ?? []).map(one => ({ ...one, id: renamed.get(one.id), session: SESSION })), messages }
}
const agentOfSample = (name, shape) => sampleOf(name, shape).message.to.split(':')[0]
const surfaces = (messaging, now = NOW, s = en) => {
  const v = viewAt(now, SOURCE, s)
  const o = { width: 120, isColor: false, messaging }
  return {
    print: board.boardText(v, [], s, o),
    watch: board.boardLayout(v, [], board.emptyBoardState, s, o).screen,
    json: boardJson.boardDocument(v, [], [], s, '/synthetic-home', false, now, group(now), undefined, messaging),
  }
}
// The line drawn under a row: the text lines after its title, up to the next title.
const linesUnder = (screen, title) => {
  const lines = screen.split('\n')
  const start = lines.findIndex(line => line.includes(title))
  assert.ok(start >= 0, `no row ${title} in\n${screen}`)
  const end = lines.findIndex((line, index) => index > start && Object.values(TITLES).some(other => line.includes(other)))
  return lines.slice(start + 1, end === -1 ? undefined : end).map(line => line.trim())
}

test('the terminal board and --print show a row\'s message status in the module\'s words', () => {
  const cases = [
    ['queued', undefined, 'Queued · now'],
    ['accepted', undefined, `Delivered · ${en.minutesAgo(5)}`],
    ['acknowledged', 'withReply', 'Read · on it'],
    ['holderLost', undefined, 'Unsure · nobody took it · check its window'],
    ['rejected', undefined, 'Not delivered · refused'],
  ]
  for (const [name, shape, line] of cases) {
    const read = surfaces(messagingOf(name, shape), name === 'queued' ? NOW : NOW + 5 * MINUTE)
    const title = TITLES[agentOfSample(name, shape)]
    for (const surface of ['print', 'watch']) assert.ok(linesUnder(read[surface], title).includes(line), `${surface}, ${name}: no "${line}" under its row\n${read[surface]}`)
    // The other rows have no message and no status line.
    for (const other of Object.values(TITLES).filter(one => one !== title)) assert.ok(!linesUnder(read.print, other).some(one => /^(Queued|Delivered|Read|Answered|Unsure|Not delivered)\b/.test(one)), other)
  }
  // Without the messages file the rows are as they were.
  const none = surfaces(undefined)
  assert.ok(!/Queued ·|Delivered ·|Not delivered/.test(none.print))
  // The zh-TW words on the terminal are the module's too.
  assert.ok(linesUnder(surfaces(messagingOf('rejected'), NOW + MINUTE, STRINGS['zh-TW']).print, TITLES.codex).includes('未送達 · 被拒絕'))
})

test('a claim just handed out reads the same on the terminal board and in --json', () => {
  const messaging = messagingOf('claimed')
  for (const [later, line] of [[5 * SECOND, 'Queued · now'], [NOW_ROUTE_MS, 'Unsure · no answer · check its window']]) {
    const read = surfaces(messaging, NOW + later)
    assert.ok(linesUnder(read.print, TITLES.codex).includes(line), `--print at +${later}\n${read.print}`)
    assert.ok(linesUnder(read.watch, TITLES.codex).includes(line), `terminal at +${later}\n${read.watch}`)
    assert.equal(read.json.working.find(row => row.agent === 'codex').message.line, line)
  }
})

test('--json gives a row and a need the message status in the module\'s words', () => {
  const read = surfaces(messagingOf('accepted'), NOW + 5 * MINUTE)
  assert.equal(read.json.schemaVersion, 1)
  assert.deepEqual(read.json.working.find(row => row.agent === 'codex').message, { state: 'delivered', line: `Delivered · ${en.minutesAgo(5)}`, updatedAt: new Date(NOW).toISOString() })
  for (const row of read.json.working.filter(one => one.agent !== 'codex')) assert.equal('message' in row, false, row.agent)
  assert.equal('message' in surfaces(undefined).json.working[0], false)

  // A question whose answer was refused waits for the person again, with that answer's status; a queued one is handled.
  const asking = `## synthetic-api
<!-- auto session=c1000001 agent=codex resume=${SESSION} state=waiting updated=${new Date(BLOCK_AT).toISOString()} -->
### Choose the limit
- [?] Limit — 100 or 300 a minute?
<!-- /auto session=c1000001 -->
`
  const v = viewAt(NOW + MINUTE, asking)
  // The question ledger names a live question; this view has none, so the id is set as queued-count.test.mjs does.
  assert.equal(v.waiting.length, 1)
  const questionId = 'Q-synthetic-1'
  v.waiting[0].questionId = questionId
  const documentFor = (name, shape) => boardJson.boardDocument(v, [], [], en, '/synthetic-home', false, NOW + MINUTE, group(NOW + MINUTE), undefined, messagingOf(name, shape, { answers: questionId, from: 'board' }))
  const refused = documentFor('rejected')
  assert.deepEqual(refused.needs.map(one => one.message), [{ state: 'notDelivered', line: 'Not delivered · refused', updatedAt: new Date(NOW).toISOString() }])
  const queued = documentFor('queuedForHook')
  assert.deepEqual(queued.queued.map(one => one.message), [{ state: 'queued', line: `Queued · at its next turn · ${en.minutesAgo(1)}`, updatedAt: new Date(NOW).toISOString() }])
  assert.equal('message' in boardJson.boardDocument(v, [], [], en, '/synthetic-home', false, NOW + MINUTE, group(NOW + MINUTE)).needs[0], false)
})

test('the terminal board, --print and --json say the same words for every delivery state', () => {
  const wrong = []
  for (const name of DELIVERY_STATES) {
    for (const shape of shapeNames(name)) {
      const messaging = messagingOf(name, shape)
      const read = surfaces(messaging, NOW)
      const agent = agentOfSample(name, shape)
      const want = statusOf(messaging.messages[0], NOW, en, BLOCK_AT)
      const json = read.json.working.find(row => row.agent === agent)?.message
      const where = `${name}.${shape}`
      if (want === null) {
        if (json !== undefined) wrong.push(`${where}: --json has ${json.line}`)
        continue
      }
      if (json?.line !== want.line || json?.state !== want.state) wrong.push(`${where}: --json ${json?.state} "${json?.line}", not ${want.state} "${want.line}"`)
      for (const surface of ['print', 'watch']) if (!linesUnder(read[surface], TITLES[agent]).includes(want.line)) wrong.push(`${where}: ${surface} has no "${want.line}"`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('one store fed to the board script gives the same status line on --print and --json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'message-status-'))
  try {
    const now = Date.now()
    const messages = join(dir, 'messages')
    mkdirSync(messages)
    const { state } = sampleOf('disconnected')
    const stored = state.messages.map(one => ({ ...one, to: `codex:${SESSION}`, updated: now - 5 * MINUTE, claimed: now - 6 * MINUTE }))
    writeFileSync(join(messages, 'messages.json'), JSON.stringify({ version: 2, messages: stored, mailboxes: [] }))
    writeFileSync(join(dir, 'progress.md'), `## synthetic-api\n${blockOf('b1000001', 'codex', TITLES.codex).replace(/updated=[^ ]+/, `updated=${new Date(now - 7 * MINUTE).toISOString()}`)}`)
    const script = join(dir, 'agent-board.mjs')
    writeFileSync(script, `globalThis.AGENT_BOARD = ${JSON.stringify({ path: join(dir, 'progress.md'), lang: 'en' })}\n${bundle.BOARD_SCRIPT}`)
    const env = { ...process.env, CLAUDE_PROGRESS_FILE: '', HOME: dir, USERPROFILE: dir, NO_COLOR: '1', LANG: 'en' }
    const run = args => spawnSync(process.execPath, [script, ...args, '--messages-dir', messages], { cwd: dir, env, timeout: 20_000, encoding: 'utf8' })
    const line = 'Unsure · connection lost · check its window'
    const printed = run(['--print'])
    assert.equal(printed.status, 0, printed.stderr)
    assert.ok(linesUnder(printed.stdout, TITLES.codex).includes(line), printed.stdout)
    const json = JSON.parse(run(['--json']).stdout)
    assert.equal(json.schemaVersion, 1)
    assert.deepEqual(json.working.find(row => row.agent === 'codex')?.message, { state: 'unsure', line, updatedAt: new Date(now - 5 * MINUTE).toISOString() })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

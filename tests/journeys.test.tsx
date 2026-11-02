import { describe, expect, test } from 'claude-code/testing'
import { applyDigest } from '../hooks/digest'
import { blockId } from '../hooks/inbox'
import { emptyMirror } from '../hooks/mirror'
import { upsertAutoBlock } from '../hooks/blocks'
import { boardText, chatText } from '../hooks/board'
import { dashboardHtml } from '../hooks/dashboard'
import { parseProgress } from '../hooks/parse'
import { emptyQuestions, observeQuestions, questionsJson } from '../hooks/questions'
import { serveModel } from '../hooks/serve'
import { EN } from '../hooks/strings-en'
import { answeredJson, answeredPath, buildView } from '../hooks/view'
import { engineBeneath, FILE, INBOX, knownFailure, makeWorld, noMachineIds, noSilentPress, PANE, PANE_MS, PROPS, start, visiblePaneText } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'
import { bigBoard, bigWorld, timeStretches, untilQuiet } from './fixtures/big-board'

const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }

const noPaneMachineIds = async (text: string, world: World, { allow = [] }: { allow?: readonly string[] } = {}): Promise<void> => {
  noMachineIds(text, world, allow)
}

const block = ({
  project = 'api-gateway',
  session = 'a1b2c3d4',
  agent = 'codex',
  state = 'working',
  title = 'Ship request tracing',
  steps = '- [~] Add trace headers',
  resume,
}: {
  project?: string
  session?: string
  agent?: string
  state?: 'working' | 'waiting' | 'done' | 'ended'
  title?: string
  steps?: string
  resume?: string
} = {}): string =>
  `## ${project}\n<!-- auto session=${session} agent=${agent} state=${state} updated=2026-10-16T12:00:00Z${resume === undefined ? '' : ` resume=${resume}`} -->\n### ${title}\n> Context: Synthetic journey data.\n${steps}\n<!-- /auto session=${session} -->\n`

describe('L1 first run', () => {
  test('L1 latency: a new ask is visible within 3 s on the pane', async ($, on) => {
    const world = makeWorld()
    world.env = english
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      expect(visiblePaneText(await ui.drawn())).toContain('No work in progress right now.')
      const started = clock.now()
      world.files.set(FILE, block({ state: 'waiting', steps: '- [?] Publish gateway routes, OK?' }))
      world.mtime += 1
      await clock.advance(2000)
      const text = visiblePaneText(await ui.drawn())
      expect(text).toContain('Publish gateway routes, OK?')
      expect(text).toContain('● 1')
      expect(clock.now() - started).toBeLessThanOrEqual(PANE_MS)
      await noPaneMachineIds(text, world)
    } finally { await ui.unmount() }
  })

  test('first run: the pane opens on an empty board with words, then shows the first block within one poll', async ($, on) => {
    const world = makeWorld()
    world.env = english
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

    expect(await ui.find({ type: 'Text', text: 'No work in progress right now.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Once Claude starts on a Task list/ })).toBeDefined()
    noMachineIds(visiblePaneText(await ui.drawn()), world)

    world.files.set(FILE, block())
    world.mtime += 1
    const started = clock.now()
    await clock.advance(2000)
    const beforePress = visiblePaneText(await ui.drawn())
    expect(beforePress).not.toContain('No work in progress right now.')
    expect(clock.now() - started).toBeLessThanOrEqual(PANE_MS)
    await ui.press({ key: 'section::others' })
    const afterPress = visiblePaneText(await ui.drawn())
    noSilentPress({ surface: 'pane', card: 'Other work', button: 'open', before: beforePress, after: afterPress })
    expect(await ui.find({ type: 'Button', key: 'api-gateway::Ship request tracing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No work in progress right now.' })).toBeUndefined()
    await noPaneMachineIds(afterPress, world)
    await ui.unmount()
  })
})

// A busy machine's board (#371). Claude Code unloads a mod whose hooks worker goes 5 s without
// a trip to the host, and on a board this size a session start used to go many seconds without
// one: then /progress was gone from every session. The budget is half the host's 5 s, so a slow or
// busy machine does not fail it while main's 14 to 23 s here still does. On an idle machine main's
// archiving alone took 3.4 s, only 1.3 times this budget, so the test that cannot be passed by a
// fast machine is the length comparison in logic.test.ts. A stretch reads as `within` or names
// where it ran.
const BUDGET_MS = 2500
const within = (ms: number | null, budget: number, at = ''): string => ms !== null && ms < budget ? 'within' : `${Math.round(ms ?? -1)} ms ${at}`
const ARCHIVE = '/home/me/.claude/progress-archive-2026-10.md'

describe('L2 a busy board', () => {
  test('L2 busy board: a session start registers /progress before it reads the board, and neither the start nor the work it leaves running goes 2.5 s without a trip to the host', { timeoutMs: 240000 }, async ($, on) => {
    const board = bigBoard()
    const world = bigWorld()
    const statuses: Array<string | undefined> = []
    on('ui.status', ($, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    const timing = timeStretches(on)
    engineBeneath(timing.on, world)
    timing.begin()
    await $.session.start({ cwd: '/work/project-3', surface: 'desktop', isInteractive: true })
    // What the start leaves running (archiving the old blocks, connecting the agents) counts too.
    await untilQuiet(timing.stretches)
    timing.stop()
    const { longest, at, trace } = timing.stretches
    const names = trace.map(([, name]) => name)
    // The listing does not wait on the board: in the test kit /progress is there at once, so the
    // seconds a real host took to list it are not reproduced here.
    expect(names.indexOf('command.register')).toBeGreaterThan(-1)
    expect(names.indexOf('command.register')).toBeLessThan(names.indexOf('fs.read progress.md'))
    // The heavy work ran: the old blocks went to the archive, and the line under the prompt counts
    // the questions of the sessions still going (23 of the 63; the rest are stopped sessions').
    expect(world.files.get(ARCHIVE)?.match(/^## /gm)?.length).toBe(board.archivable)
    expect(board.waitingNow).toBe(23)
    expect(statuses).toContain(`${EN.statusPrefix} · ${EN.statusWaiting(board.waitingNow)}`)
    expect(within(longest, BUDGET_MS, at)).toBe('within')
  })

  // The test kit drops a mock clock's timers ten seconds of real time after they were set, and on
  // this board a poll takes most of a second in the kit, so the poll after the start stands in
  // for the minute after it.
  test('L2 busy board: after the start and the poll that follows, /progress still answers and no stretch reaches 2.5 s', { timeoutMs: 240000 }, async ($, on) => {
    const board = bigBoard()
    const world = bigWorld()
    const timing = timeStretches(on)
    const clock = engineBeneath(timing.on, world)
    timing.begin()
    await $.session.start({ cwd: '/work/project-3', surface: 'desktop', isInteractive: true })
    // The poll comes while the start's archiving and connecting still run, as it does in a session.
    await clock.advance(2000)
    await untilQuiet(timing.stretches)
    timing.stop()
    timing.begin()
    const ran = await $.command.run({ command: 'progress', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    timing.stop()
    expect(ran.text).toBe(EN.paneOpened(FILE))
    expect(world.files.get(ARCHIVE)?.match(/^## /gm)?.length).toBe(board.archivable)
    expect(within(timing.stretches.longest, BUDGET_MS, timing.stretches.at)).toBe('within')
  })
})

describe('L2 a working day', () => {
  test('a working day: an ask answered from the pane leaves the waiting count with a visible result', async ($, on) => {
    const world = makeWorld()
    world.env = english
    const clock = engineBeneath(on, world)
    const submitted: string[] = []
    on('prompt.submit', ($, event) => {
      submitted.push(event.text)
      return { text: event.text }
    })
    await start($, 'Prepare the release')
    await $.tool.call({ tool: 'TaskCreate', subject: 'Choose rollout', description: '' })
    await $.tool.call({
      tool: 'TaskUpdate',
      taskId: '1',
      metadata: { waiting: 'you', ask: 'choose', options: ['Canary', 'Everyone'], why: 'Which rollout?' },
    })
    await $.turn.complete({ answer: 'Choose a rollout.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(10)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    const before = world.files.get(FILE) ?? ''
    expect(await ui.find({ type: 'Text', text: '● 1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'mine::1::Canary' })).toBeDefined()
    noMachineIds(visiblePaneText(await ui.drawn()), world)
    const started = clock.now()
    await ui.press({ key: 'mine::1::Canary' })
    await clock.advance(10)
    const firstRender = visiblePaneText(await ui.drawn())
    expect(firstRender).toContain('Nothing needs you right now')
    expect(clock.now() - started).toBeLessThanOrEqual(PANE_MS)
    const after = world.files.get(FILE) ?? ''
    noSilentPress({ surface: 'pane', card: 'Choose rollout', button: 'Canary', before, after })
    expect(submitted.at(-1)).toBe('About "Choose rollout": Canary')
    expect(after).not.toBe(before)
    expect(after).toContain('- [ ] Choose rollout — answered, waiting on Claude')
    expect(await ui.find({ type: 'Text', text: '● 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ Nothing needs you right now' })).toBeDefined()
    await noPaneMachineIds(visiblePaneText(await ui.drawn()), world)
    await ui.unmount()
  })
})

describe('L3 across agents and sessions', () => {
  test('L3 across agents: a Codex ask on a Claude pane says where to answer it, and once Codex has its answer it leaves every surface', async ($, on) => {
    const at = Date.parse('2026-10-16T12:00:00Z')
    const ownerId = blockId('codex', 'synthetic-codex-owner')
    const owner = {
      ...applyDigest(
        emptyMirror(ownerId, 'api-gateway', at, '/work/api-gateway', 'codex'),
        { title: 'Set the retry limit', context: 'Synthetic journey data.', done: '', next: 'Apply the retry limit', ask: 'Retry limit', why: '3 or 5 attempts?' },
        at,
      ),
      resume: 'synthetic-codex-owner',
      firstPrompt: 'Set a retry limit',
      turnOrder: at * 2,
    }
    const initial = upsertAutoBlock('# Progress\n', owner, EN)
    const world = makeWorld([[FILE, initial]])
    world.env = english
    world.store = { inboxDone: {}, autoConnectOff: true, [`agent:${ownerId}`]: owner }
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })

    expect(await ui.find({ type: 'Text', text: '● 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 or 5 attempts?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Reply in the "Set the retry limit" session/ })).toBeDefined()

    const beforeHide = visiblePaneText(await ui.drawn())
    expect(beforeHide).toContain("Can't reply from here.")
    const project = parseProgress(initial)[0]!
    const task = project.tasks[0]!
    const key = `${project.name}::${task.title}::${task.steps.findIndex(step => step.status === 'waiting')}`
    expect(await ui.find({ type: 'Button', key: `${key}::hide` })).toBeDefined()
    await ui.press({ key: `${key}::hide` })
    await clock.advance(10)
    const afterHide = visiblePaneText(await ui.drawn())
    noSilentPress({ surface: 'pane', card: 'Set the retry limit', button: 'Already answered, hide', before: beforeHide, after: afterHide })

    world.files.set(`${INBOX}/codex-prompt-${at + 1000}-1.json`, JSON.stringify({
      session_id: 'synthetic-codex-owner',
      prompt: '3 attempts',
      transcript_path: '/private/synthetic-codex-owner.jsonl',
    }))
    world.mtime += 1
    await clock.advance(5000)
    const answered = world.files.get(FILE) ?? ''
    expect(answered).toContain('- [x] Retry limit — 3 or 5 attempts?')
    expect(answered).not.toContain('- [?] Retry limit')
    expect(await ui.find({ type: 'Text', text: '● 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ Nothing needs you right now' })).toBeDefined()
    await noPaneMachineIds(visiblePaneText(await ui.drawn()), world)

    const view = buildView(parseProgress(answered), [], null, at + 5000, 0, {}, EN)
    const page = serveModel(view, [], EN)
    expect(page.counts.waiting).toBe(0)
    expect(page.asks).toHaveLength(0)
    const surfaces = {
      terminal: boardText(view, [], EN),
      chat: chatText(view, [], [], EN, '/home/me'),
      page: [...page.asks.map(ask => ask.text), ...page.groups.flatMap(group => group.rows.flatMap(row => [row.title, row.status, row.next ?? '']))].join(' '),
      html: dashboardHtml(view, EN, FILE, ''),
    }
    for (const visible of [surfaces.terminal, surfaces.chat]) {
      expect(visible).toContain('0 waiting')
      expect(visible).toContain('Nothing needs you right now')
    }
    expect(surfaces.terminal).toContain('✓ 1 Retry limit')
    expect(surfaces.terminal).not.toContain('● 1 Retry limit')
    // progress.html counts what needs you in its Needs you flag, as the page does.
    expect(surfaces.html).toContain('<b id="needs-n">0</b>')
    expect(surfaces.html).toContain('Nothing needs you right now')
    for (const visible of Object.values(surfaces)) {
      noMachineIds(visible, world)
      expect(visible).not.toContain('1 waiting')
    }
    await ui.unmount()
  })

  test('across sessions: two pane sessions on one file agree on an answer within one poll', async ($, on) => {
    const at = Date.parse('2026-10-16T12:00:00Z')
    const source = block({ state: 'waiting', title: 'Choose cache TTL', steps: '- [?] Cache for 5 minutes, OK?' })
    const ledger = observeQuestions(emptyQuestions(), parseProgress(source), null, [], at, true, 'pane-journey:1').ledger
    const questions = FILE.replace(/\.md$/i, '-questions.json')
    const answers = answeredPath(FILE)
    const world = makeWorld([[FILE, source], [questions, questionsJson(ledger)]])
    world.env = english
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      expect(await ui.find({ type: 'Text', text: 'Cache for 5 minutes, OK?' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '● 1' })).toBeDefined()

      // Session A handles the question through the same durable identity file a pane press writes.
      const started = clock.now()
      world.files.set(answers, answeredJson([ledger.records[0]!.id]))
      await clock.advance(2100)
      const after = visiblePaneText(await ui.drawn())

      expect(after).not.toContain('Cache for 5 minutes, OK?')
      expect(after).toContain('Nothing needs you right now')
      expect(clock.now() - started).toBeLessThanOrEqual(PANE_MS)
      await noPaneMachineIds(after, world)
    } finally { await ui.unmount() }
  })
})

describe('L3b messages between sessions and agents', () => {
  test('messages: a Claude pane shows the Codex fallback while native reply remains tracked by #58', async ($, on) => {
    const source = block({
      state: 'waiting',
      title: 'Review gateway message',
      steps: '- [?] Check gateway — `node check-gateway.mjs`',
      resume: 'synthetic-codex-session',
    })
    const world = makeWorld([[FILE, source]])
    world.env = english
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      const before = visiblePaneText(await ui.drawn())
      await noPaneMachineIds(before, world)
      expect(before).toContain('Reply in the "Review gateway message" session')
      expect(before).toContain("Can't reply from here.")
      expect(before).toContain('node check-gateway.mjs')
      const project = parseProgress(source)[0]!
      const task = project.tasks[0]!
      const key = `${project.name}::${task.title}::${task.steps.findIndex(step => step.status === 'waiting')}`
      expect(await ui.find({ type: 'Button', key: `${key}::resume` })).toBeDefined()
      await ui.press({ key: `${key}::resume` })
      await clock.advance(10)
      const after = visiblePaneText(await ui.drawn())
      noSilentPress({ surface: 'pane', card: 'Review gateway message', button: 'Copy resume command', before, after })
      expect(after).toContain('node check-gateway.mjs')
      await noPaneMachineIds(after, world, { allow: [task.auto!.resume!] })
      await knownFailure(58, async () => {
        expect(await ui.find({ type: 'Input', key: `${key}::reply` })).toBeDefined()
        await ui.input({ key: `${key}::reply`, text: 'The gateway is ready.' })
      })
    } finally { await ui.unmount() }
  })

  test('L3b messages: a delivered message to another agent shows on the Claude pane', async ($, on) => {
    const source = block({ title: 'Review arrived message', steps: '- [~] A synthetic message arrived.' })
    const receiptFile = '/work/persona_framework/messages/messages.json'
    const receipt = {
      version: 1,
      messages: [{
        id: 'AB-synthetic-message',
        target: 'synthetic-connection',
        turn: 'synthetic-turn',
        from: 'board',
        to: 'codex:synthetic-codex-session',
        text: 'A synthetic message arrived.',
        status: 'acknowledged',
        updated: Date.parse('2026-10-16T12:00:00Z'),
        reply: 'ACK AB-synthetic-message',
        error: '',
      }],
    }
    const world = makeWorld([[FILE, source], [receiptFile, JSON.stringify(receipt)]])
    world.env = english
    const clock = engineBeneath(on, world)
    await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      const before = visiblePaneText(await ui.drawn())
      await ui.press({ key: 'section::others' })
      await clock.advance(10)
      const after = visiblePaneText(await ui.drawn())
      noSilentPress({ surface: 'pane', card: 'Other work', button: 'open', before, after })
      expect(after).toContain('Review arrived message')
      expect(JSON.parse(world.files.get(receiptFile) ?? '{}').messages[0]).toMatchObject({
        status: 'acknowledged',
        reply: 'ACK AB-synthetic-message',
      })
      await noPaneMachineIds(after, world)
      await knownFailure(232, () => {
        expect(after).toContain('Replied')
        expect(after).toContain('ACK AB-synthetic-message')
      })
    } finally { await ui.unmount() }
  })
})


test('L7 pane: no session id, hash or file path on the default pane', async ($, on) => {
  const source = block({ resume: '12345678-1234-4234-8234-123456789abc', state: 'waiting', steps: '- [?] Publish the gateway, OK?' }) +
    block({ project: 'docs-site', session: 'b1000002', agent: 'claude', resume: '22345678-1234-4234-8234-123456789abc', title: 'Prepare documentation' })
  const at = Date.parse('2026-10-16T12:00:00Z')
  const ledger = observeQuestions(emptyQuestions(), parseProgress(source), null, [], at, true, 'plain-words:1').ledger
  const world = makeWorld([[FILE, source], ['/home/me/.claude/progress-questions.json', questionsJson(ledger)]])
  world.env = english
  engineBeneath(on, world)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    noMachineIds(visiblePaneText(await ui.drawn()), world)
    await ui.press({ key: 'section::others' })
    const visible = visiblePaneText(await ui.drawn())
    expect(visible).toContain('Ship request tracing')
    expect(visible).toContain('Prepare documentation')
    expect(visible).toContain(EN.progressFileShown)
    noMachineIds(visible, world)
  } finally { await ui.unmount() }
})

test('L7 pane: an unreadable progress file is named in words, with no path and no raw error', async ($, on) => {
  const world = makeWorld([[FILE, block()]])
  world.env = english
  engineBeneath(((...args: Parameters<typeof on>) => {
    if (args[0] !== 'fs.read') return Reflect.apply(on, undefined, args)
    return on('fs.read', ($, e) => {
      const path = e.path.replace(/^[A-Za-z]:\\/, '/').replace(/\\/g, '/')
      if (path === FILE) return { deny: 'EACCES' }
      const text = world.files.get(path)
      return text === undefined ? { deny: 'ENOENT' } : { value: text }
    })
  }) as typeof on, world)
  await start($, 'Inspect the unreadable progress file')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const visible = visiblePaneText(await ui.drawn())
    expect(visible).toContain(EN.fileUnreadable)
    expect(visible).toContain(EN.storageReadOnly)
    expect(visible).not.toContain(FILE)
    expect(visible).not.toContain('EACCES')
    noMachineIds(visible, world)
  } finally { await ui.unmount() }
})

test('L7 pane: an unreadable progress file never shows a word from its path or an unknown error code', async ($, on) => {
  const path = '/home/EVAN/TEAM_DATA/.claude/progress.md'
  const messages = [`open '${path}' failed: EPERM`, 'EIO: i/o error, read', 'something went wrong']
  let message = messages[0]!
  const world = makeWorld([[FILE, block()]])
  world.env = english
  const clock = engineBeneath(((...args: Parameters<typeof on>) => {
    if (args[0] !== 'fs.read') return Reflect.apply(on, undefined, args)
    return on('fs.read', ($, e) => {
      const file = e.path.replace(/^[A-Za-z]:\\/, '/').replace(/\\/g, '/')
      if (file === FILE) return { deny: message }
      const text = world.files.get(file)
      return text === undefined ? { deny: 'ENOENT' } : { value: text }
    })
  }) as typeof on, world)
  await start($, 'Inspect synthetic read failures')
  for (const [index, error] of messages.entries()) {
    message = error
    world.mtime += 1
    await clock.advance(2000)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      const visible = visiblePaneText(await ui.drawn())
      expect(visible).toContain(EN.fileUnreadable)
      if (index === 0) expect(visible).toContain(EN.storageReadOnly)
      else {
        expect(visible).not.toContain(EN.storageReadOnly)
        expect(visible).not.toContain(EN.storageBusy)
        expect(visible).not.toContain(EN.storageFull)
        expect(visible.trim()).toBe(EN.fileUnreadable)
      }
      for (const hidden of [path, FILE, 'EVAN', 'TEAM_DATA', 'EPERM', 'EIO', 'UNKNOWN']) expect(visible).not.toContain(hidden)
      noMachineIds(visible, world)
    } finally { await ui.unmount() }
  }
})

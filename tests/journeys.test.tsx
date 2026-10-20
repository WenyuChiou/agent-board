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

const english = { HOME: '/home/me', LANG: 'en_US.UTF-8' }

const noPaneMachineIds = async (text: string, world: World, { allow = [] }: { allow?: readonly string[] } = {}): Promise<void> => {
  noMachineIds(text, world, [FILE, ...allow])
  await knownFailure(250, () => noMachineIds(text, world, allow))
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
    noMachineIds(visiblePaneText(await ui.drawn()), world, [FILE])

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
    noMachineIds(visiblePaneText(await ui.drawn()), world, [FILE])
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
    expect(surfaces.html).toContain('● 0</span> waiting')
    expect(surfaces.html).toContain('Nothing needs you right now')
    for (const [surface, visible] of Object.entries(surfaces)) {
      if (surface === 'html') {
        noMachineIds(visible, world, [FILE])
        await knownFailure(250, () => noMachineIds(visible, world))
      } else {
        noMachineIds(visible, world)
      }
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

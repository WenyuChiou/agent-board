import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { opencodePlugin } from '../hooks/connect-pure'
import { emptyMirror } from '../hooks/mirror'
import { blockId } from '../hooks/inbox'
import { archivePath, journalPath } from '../hooks/journal'
import { boardTag } from '../hooks/retention'
import { parseCapture, parseQuestions } from '../hooks/questions'
import { BIG_AT, bigWorld } from './fixtures/big-board'
import { engineBeneath, FILE, INBOX, makeWorld, PANE, PROPS } from './fixtures/pane-world'
import type { World } from './fixtures/pane-world'

const HOUR = 3600000
const DAY = 86400000
const STORE = '/home/me/.claude/plugins/store/agent-board_agent-board-0123456789ab.json'
const PAGE = '/home/me/.claude/progress.html'
const QUESTIONS = '/home/me/.claude/progress-questions.json'
const FIRST = '11111111-0000-4000-8000-000000000001'
const SECOND = '22222222-0000-4000-8000-000000000002'
const bytes = (text: string): number => new TextEncoder().encode(text).length
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
const turnsOf = (world: World): string[] => [...world.files.keys()].filter(path => path.startsWith(`${INBOX}/`) && /\/(?:[a-z][a-z0-9]*)-(?:prompt|turn|end)-[\w.-]+\.json$/.test(path))

type Removal = { key: string; day: string }
type Count = { agent: number; mirror: number }

// The real engine writes the store to its file before a prune measures it, so this fixture does too.
// The clock moves an hour at a time, so each hour's jobs finish before the next hour starts.
const trackedWorld = (on: On, world: World): { clock: { advance: (ms: number) => Promise<void> }; removed: Removal[]; session: { id: string } } => {
  const removed: Removal[] = []
  const session = { id: FIRST }
  let at = world.at ?? BIG_AT
  world.isArchiveClockOnly = true
  world.beforeStoreGet = key => {
    if (key === 'pruneAfter') world.files.set(STORE, JSON.stringify(world.store))
  }
  const wrapped = ((...args: Parameters<On>) => {
    if (args[0] === 'session.id') return on('session.id', () => ({ value: session.id }))
    if (args[0] !== 'store.delete') return Reflect.apply(on, undefined, args)
    const handler = args.at(-1)
    if (typeof handler !== 'function') throw new Error('Missing fixture handler')
    return on('store.delete', ($, event, next) => {
      const hasRecord = Object.hasOwn(world.store ?? {}, event.key) && /^(agent|mirror):/.test(event.key)
      const result = Reflect.apply(handler, undefined, [$, event, next])
      if (hasRecord) removed.push({ key: event.key, day: dayOf(at) })
      return result
    })
  }) as On
  const original = engineBeneath(wrapped, world)
  on('ui.status', () => ({ value: undefined }))
  world.files.set(STORE, JSON.stringify(world.store))
  const advance = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0;) {
      const step = Math.min(HOUR, left)
      at += step
      await original.advance(step)
      left -= step
    }
  }
  return { clock: { advance }, removed, session }
}
const endedRecord = (id: string, at: number, agent: string, padding = 400000): ProgressMirror & { padding: string } => ({
  ...emptyMirror(id, 'synthetic-days', at, '/home/me/work/synthetic-days', agent),
  board: boardTag(FILE),
  state: 'ended',
  padding: 's'.repeat(padding),
})

const expectedCounts = (removed: readonly Removal[], at: number): Record<string, Count> => {
  const since = dayOf(at - 6 * DAY)
  const result: Record<string, Count> = {}
  for (const one of removed) {
    if (one.day < since) continue
    const count = result[one.day] ?? { agent: 0, mirror: 0 }
    if (one.key.startsWith('agent:')) count.agent += 1
    else count.mirror += 1
    result[one.day] = count
  }
  return result
}

const clearedLine = (counts: Record<string, Count>, turns: number): string => {
  const total = Object.values(counts).reduce((sum, one) => ({ agent: sum.agent + one.agent, mirror: sum.mirror + one.mirror }), { agent: 0, mirror: 0 })
  const parts = [
    ...(total.agent === 0 ? [] : [`${total.agent} old agent ${total.agent === 1 ? 'record' : 'records'}`]),
    ...(total.mirror === 0 ? [] : [`${total.mirror} old session ${total.mirror === 1 ? 'task list' : 'task lists'}`]),
    `${turns} unread inbox turns`,
  ]
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `Cleared ${list} in the last 7 days`
}

const send = (world: World, agent: string, event: string, at: number, day: number, answer = ''): void => {
  world.files.set(`${INBOX}/${agent}-${event}-${at}-${day}.json`, JSON.stringify({ session_id: `synthetic-${agent}-${day}`, cwd: '/home/me/work/synthetic-days', prompt: event === 'prompt' ? 'Use the synthetic preview' : 'Prepare the synthetic report', last_assistant_message: answer }))
}

const taskTurn = async ($: Engine, day: number, taskId: string): Promise<void> => {
  await $.turn.start({ text: `Prepare synthetic day ${day}`, turnId: `day-${day}` })
  await $.tool.call({ tool: 'TaskCreate', subject: `Synthetic daily step ${day}`, description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId, status: 'completed' })
  await $.turn.complete({ answer: 'Synthetic daily step finished.', durationMs: 1, isAborted: false, turnId: `day-${day}`, reason: 'answer' })
}

const assertParts = (world: World): void => {
  const parts = [...world.files].filter(([path]) => /progress-(journal|archive)-\d{4}-\d\d(?:-\d+)?\.md$/.test(path))
  expect(parts.length).toBeGreaterThan(0)
  for (const [, text] of parts) expect(bytes(text)).toBeLessThanOrEqual(1048576)
}

const seedParts = (world: World, at: number): void => {
  for (const base of [journalPath(FILE, at), archivePath(FILE, at)]) {
    world.files.set(base, 'x'.repeat(1048576))
    world.files.set(base.replace('.md', '-2.md'), 'x'.repeat(1048576))
  }
}

test('thirty simulated days keep the storage caps and count every removed record', { timeoutMs: 300000 }, async ($, on) => {
  const world = makeWorld([[FILE, '## synthetic-days\n### Synthetic hand-kept task\n- [ ] Synthetic manual step\n']])
  world.at = BIG_AT
  world.env = { HOME: '/home/me', LANG: 'en_US.UTF-8' }
  world.isArchiveClockOnly = true
  world.ran = []
  world.store = {
    ...world.store,
    opened: ['others', 'stopped'],
    lang: 'en',
    told: Object.fromEntries(Array.from({ length: 600 }, (_, n) => [`ask:${n.toString(16).padStart(16, '0')}`, BIG_AT - (n + 1) * 1000])),
  }
  world.reply = prompt => prompt.includes('TITLE:') ? `TITLE: Synthetic daily report\nCONTEXT: Synthetic day\nDONE: Prepared synthetic report\nNEXT: Review synthetic report\nASK: ${prompt.includes('Use the synthetic preview, OK?') ? 'Synthetic preview — Use the synthetic preview, OK?' : '-'}` : undefined
  seedParts(world, BIG_AT)
  const { clock, removed, session } = trackedWorld(on, world)
  let at = BIG_AT
  const droppedDays: Array<{ day: string; count: number }> = []
  // Reporter processes run outside the plugin sandbox; their generated guard must keep these literal limits.
  expect(opencodePlugin({ home: '/home/me', inbox: INBOX })).toContain('if (files <= 1000 && bytes <= 1572864) break')
  const inserted = new Set<string>()
  // Recently ended records cannot age out yet, so these, saved before the first day, press on the
  // hard cap itself.
  for (let n = 0; n < 4; n += 1) {
    const id = (100 + n).toString(16).padStart(8, '0')
    const key = `${n % 2 === 0 ? 'agent' : 'mirror'}:${id}`
    ;(world.store as Record<string, unknown>)[key] = endedRecord(id, at - HOUR - n, n % 2 === 0 ? 'codex' : 'claude', n % 2 === 0 ? 800000 : 256)
    inserted.add(key)
  }
  await $.session.start({ cwd: '/home/me/work/synthetic-days', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  if (await ui.find({ type: 'Button', key: 'synthetic-days::Synthetic hand-kept task::tick' }) === undefined) await ui.press({ key: 'synthetic-days::Synthetic hand-kept task' })
  await ui.press({ key: 'synthetic-days::Synthetic hand-kept task::tick' })
  expect(world.files.get(FILE)).toContain('- [x] Synthetic manual step')
  await ui.unmount()

  for (let day = 1; day <= 30; day += 1) {
    if (day === 16) {
      await $.session.end({ sessionId: session.id })
      session.id = SECOND
      await $.session.start({ cwd: '/home/me/work/synthetic-days', surface: 'desktop', isInteractive: true })
    }
    const store = world.store as Record<string, unknown>
    const before = new Set(Object.keys(store).filter(key => /^(agent|mirror):/.test(key)))
    // A reporter that removed three turns over the inbox cap writes this line. The reporter tests
    // cover the removal itself, so here only the pane's count of these lines is checked.
    droppedDays.push({ day: dayOf(at), count: 3 })
    world.files.set(`${INBOX}/dropped.log`, (world.files.get(`${INBOX}/dropped.log`) ?? '') + new Date(at).toISOString().slice(0, 19) + 'Z 3 cap\n')
    if (day === 1 || day === 16) await taskTurn($, day, day === 1 ? '1' : '2')
    for (const agent of ['codex', 'grok']) send(world, agent, 'turn', at + 1000, day, 'Synthetic report ready.')
    // One question is enough to follow ask, answer and session end without manufacturing ledger growth.
    if (day === 1) send(world, 'codex', 'turn', at + 2000, day, 'Use the synthetic preview, OK?')
    const board = (world.files.get(FILE) ?? '').replace(/\n<!-- synthetic-size -->[\s\S]*?<!-- \/synthetic-size -->\n/g, '')
    const opening = '\n<!-- synthetic-size -->\n'
    const closing = '\n<!-- /synthetic-size -->\n'
    // The pane's own writes move the file off these sizes before the pane is opened, so the check
    // below holds the warning to the size the file then has; retention.test.ts pins the boundary.
    const target = day === 1 ? 524288 : day === 2 ? 524289 : 0
    world.files.set(FILE, board + opening + 'x'.repeat(Math.max(0, target - bytes(board + opening + closing))) + closing)
    world.mtime += 1
    await clock.advance(6 * HOUR)
    if (day === 1) {
      if (!(parseQuestions(world.files.get(QUESTIONS) ?? '')?.records ?? []).some(record => record.isUnresolved)) throw new Error('The first day did not capture the synthetic preview question')
      send(world, 'codex', 'prompt', at + 6 * HOUR + 1000, day)
    }
    for (const agent of ['codex', 'grok']) send(world, agent, 'end', at + 6 * HOUR + 2000, day)
    await clock.advance(18 * HOUR)
    at += DAY

    // Opening the pane once a day checks its output without replaying hundreds of unused renders.
    const dailyPane = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    expect(bytes(JSON.stringify(store))).toBeLessThan(1572864)
    assertParts(world)
    const counted = expectedCounts(removed, at)
    // The saved counts age when a prune writes them; the display uses today's seven-day window.
    const lastRemoved = removed.at(-1)?.day
    const savedAt = lastRemoved === undefined ? at : Date.parse(`${lastRemoved}T00:00:00Z`)
    expect(store.prunedCounts).toEqual(expectedCounts(removed, savedAt))
    const turns = droppedDays.filter(one => one.day >= dayOf(at - 6 * DAY)).reduce((sum, one) => sum + one.count, 0)
    if ([1, 7, 30].includes(day)) expect(await dailyPane.find({ type: 'Text', text: clearedLine(counted, turns) })).toBeDefined()
    for (const key of before) {
      if (!Object.hasOwn(store, key)) expect(removed.some(one => one.key === key)).toBe(true)
    }
    for (const key of inserted) {
      if (!Object.hasOwn(store, key)) expect(removed.filter(one => one.key === key)).toHaveLength(1)
    }
    expect(Object.keys(store.told as Record<string, number> ?? {}).length).toBeLessThanOrEqual(500)
    const warning = await dailyPane.find({ type: 'Text', text: /progress\.md is/ })
    if ((warning !== undefined) !== (bytes(world.files.get(FILE) ?? '') > 524288)) throw new Error(`Day ${day}: progress.md has ${bytes(world.files.get(FILE) ?? '')} bytes; warning shown: ${warning !== undefined}`)
    const captures = [...world.files].filter(([path]) => /progress-questions-source-[0-9a-f]+\.json$/.test(path))
    // Source copies and proofs are recovery evidence in this branch and have no deletion rule.
    expect(captures.length).toBeGreaterThan(0)
    for (const [path, text] of captures) expect(parseCapture(text, path.slice(path.lastIndexOf('-') + 1, -5))).not.toBeNull()
    expect(captures.length).toBeLessThanOrEqual(16)
    for (const kind of ['retired', 'consumed']) expect([...world.files.keys()].filter(path => path.includes(`-questions-${kind}-`)).length).toBeLessThanOrEqual(16)
    await dailyPane.unmount()
  }
  await $.session.end({ sessionId: session.id })
  expect(removed.length).toBeGreaterThan(30)
  expect(new Set(removed.map(one => one.key)).size).toBe(removed.length)
  expect(world.files.has(journalPath(FILE, BIG_AT).replace('.md', '-3.md'))).toBe(true)
  expect(world.files.has(archivePath(FILE, BIG_AT).replace('.md', '-3.md'))).toBe(true)
  if (!removed.some(one => one.key === `mirror:${FIRST}`)) throw new Error('The first ended Claude session did not age out')
  expect(world.store?.[`mirror:${SECOND}`]).toBeDefined()
  expect((world.ran ?? []).length).toBeGreaterThan(0)
})

test('a day on the large board shows agent work, size warnings and cleared counts in English and Traditional Chinese on the pane and page', { timeoutMs: 300000 }, async ($, on) => {
  const world = { ...bigWorld(), isArchiveClockOnly: true, ran: [] as string[][] }
  const store = world.store as Record<string, unknown>
  store.lang = 'en'
  store.opened = ['others', 'stopped', 'idle', 'steps']
  // The seeded files are yesterday's received turns; this day adds its own unread turns below.
  store.inboxDone = Object.fromEntries(turnsOf(world).map(path => [path.slice(INBOX.length + 1), `synthetic:${BIG_AT}`]))
  world.files.set('/home/me/.agent-board/legacy-connect.json', JSON.stringify({ version: 1 }))
  for (const [key, value] of Object.entries({ ...store })) {
    if (key.startsWith('done:')) {
      store.doneSeen = { ...(store.doneSeen as Record<string, number> ?? {}), [key]: value }
      delete store[key]
    }
  }
  // Hand-kept context keeps the warning visible even after old blocks leave the large board.
  const source = world.files.get(FILE) ?? ''
  const extra = '\n## synthetic-days\n### Synthetic hand-kept task\n> Context: '
  world.files.set(FILE, source + extra + 'Synthetic day\n- [ ] Synthetic manual step\n')
  for (let n = 0; n < 8; n += 1) store[`agent:ffee${n.toString(16).padStart(4, '0')}`] = endedRecord(`ffee${n.toString(16).padStart(4, '0')}`, BIG_AT - 4 * DAY, 'codex', 512)
  const { clock, removed } = trackedWorld(on, world)
  await $.session.start({ cwd: '/home/me/work/synthetic-days', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  for (const agent of ['codex', 'grok']) send(world, agent, 'turn', BIG_AT + 1000, 1, 'Synthetic report ready.')
  world.reply = prompt => prompt.includes('TITLE:') ? 'TITLE: Synthetic daily report\nCONTEXT: Synthetic day\nDONE: Prepared synthetic report\nNEXT: Review synthetic report\nASK: -' : undefined
  await clock.advance(22 * HOUR)
  // Settings cannot be pruned; their bytes exercise the near-cap warning after the old records go.
  store.syntheticSetting = 'x'.repeat(Math.max(0, 1300000 - bytes(JSON.stringify(store))))
  world.files.set(FILE, (world.files.get(FILE) ?? '').replace('> Context: Synthetic day\n- [ ] Synthetic manual step', `> Context: ${'x'.repeat(524289)}\n- [ ] Synthetic manual step`))
  world.mtime += 1
  await clock.advance(2 * HOUR)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  expect(removed.length).toBeGreaterThan(0)
  const counts = expectedCounts(removed, BIG_AT + DAY)
  expect(store.prunedCounts).toEqual(counts)
  const total = Object.values(counts).reduce((sum, one) => ({ agent: sum.agent + one.agent, mirror: sum.mirror + one.mirror }), { agent: 0, mirror: 0 })
  for (const lang of ['en', 'zh-TW'] as const) {
    if (lang === 'zh-TW') await $.command.run({ command: 'progress', args: 'lang zh-TW', origin: { kind: 'composer' } })
    const cleared = lang === 'en' ? `Cleared ${total.agent} old agent records in the last 7 days` : `最近 7 天清掉了 ${total.agent} 筆舊的 agent 紀錄`
    expect(total.mirror).toBe(0)
    if (await ui.find({ type: 'Text', text: cleared }) === undefined) throw new Error(`Pane missing cleared line: ${cleared}`)
    for (const agent of ['codex', 'grok']) {
      const id = blockId(agent, `synthetic-${agent}-1`)
      if (store[`agent:${id}`] === undefined) throw new Error(`The day's ${agent} turn was not received`)
      expect(world.files.get(FILE)).toContain(`session=${id}`)
    }
    const isText = await ui.find({ type: 'Text', text: /Synthetic daily report/ }) !== undefined
    const isButton = await ui.find({ type: 'Button', text: /Synthetic daily report/ }) !== undefined
    expect(isText || isButton).toBe(true)
    await $.command.run({ command: 'progress', args: 'open', origin: { kind: 'composer' } })
    const page = world.files.get(PAGE) ?? ''
    expect(page).toContain('Synthetic daily report')
    expect(page).toContain(cleared)
    const size = bytes(world.files.get(FILE) ?? '')
    const warning = lang === 'en' ? `progress.md is ${Math.round(size / 1024)} KB, over 512 KB` : `progress.md 已有 ${Math.round(size / 1024)} KB，超過 512 KB`
    expect(size).toBeGreaterThan(524288)
    if (await ui.find({ type: 'Text', text: new RegExp(warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }) === undefined) throw new Error(`Pane missing progress warning: ${warning}`)
    expect(page).toContain(warning)
    const storeWarning = lang === 'en' ? 'The board\'s saved records are 1.2 MB (limit 1.5 MB)' : '看板存的紀錄已有 1.2 MB（上限 1.5 MB）'
    if (await ui.find({ type: 'Text', text: /1\.2 MB/ }) === undefined) throw new Error(`Pane missing store warning at ${bytes(JSON.stringify(store))} bytes`)
    expect(page.replace(/&#39;/g, "'")).toContain(storeWarning)
  }
  await ui.unmount()
})

import { EN, FILE, JOURNAL, PANE, PROPS, ZH_TW, besideButton, engineBeneath, expect, probeStart, test, type Engine, type On, type PressNode, type World } from './pane-helpers'

// A native pane press carries the step it drew through the queued write (#1228): another
// writer that moves lines between the draw and the write must not turn the press onto an
// identical twin that now sits on the drawn line, and every refusal leaves the progress
// file, the journal and the card's notice as they should be.
type Ui = Awaited<ReturnType<Engine['ui']['mount']>>
type Case = {
  before: string
  // The row to open before its Tick shows (none for a question's Done).
  open?: (keys: readonly string[]) => string | undefined
  press: (keys: readonly string[]) => string | undefined
  // What another writer does between the draw and the press.
  change?: (text: string) => string
  // What another writer does after the queued write's first read, so its retry reads it.
  changeOnRetry?: (text: string) => string
  // What another writer, working from the file it read before the press, writes right after the tick lands.
  changeAfterWrite?: (drawn: string) => string
  // The other writer works from the file with the tick in it, not from the drawn file.
  keepTick?: boolean
  lang?: 'en'
}

const worldOf = (text: string, lang?: 'en'): World => ({ files: new Map([[FILE, text]]), mtime: 1, hasTasks: true, store: { inboxDone: {}, autoConnectOff: true, opened: ['others', 'waiting'], ...(lang === undefined ? {} : { lang }) } })
const journalOf = (world: World): string => world.files.get(JOURNAL) ?? ''
const keysOf = async (ui: Ui): Promise<string[]> => {
  const walk = (node: PressNode): PressNode[] => [node, ...((node.children ?? []) as PressNode[]).flatMap(child => typeof child === 'object' && child !== null ? walk(child) : [])]
  return (await ui.findAll({ type: 'Button' }) as PressNode[]).flatMap(walk).filter(node => node.type === 'Button').map(node => String(node.key ?? node.props?.key ?? ''))
}
const firstOf = (pattern: RegExp) => (keys: readonly string[]): string | undefined => keys.filter(key => pattern.test(key)).sort()[0]

// Draws the pane, lets another writer change the file, then presses.
const pressAfter = async ($: Engine, on: On, one: Case): Promise<{ world: World; ui: Ui; key: string; drawn: string }> => {
  const world = worldOf(one.before, one.lang)
  engineBeneath(on, world)
  await probeStart($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  if (one.open !== undefined) {
    const row = one.open(await keysOf(ui))
    expect(row).toBeDefined()
    await ui.press({ key: row! })
  }
  const key = one.press(await keysOf(ui))
  expect(key).toBeDefined()
  expect(await ui.find({ type: 'Button', key: key! })).toBeDefined()
  const drawn = world.files.get(FILE) ?? ''
  if (one.change !== undefined) {
    world.files.set(FILE, one.change(drawn))
    world.mtime += 1
  }
  if (one.changeOnRetry !== undefined) {
    let isDone = false
    world.afterRead = path => {
      if (isDone || path !== FILE) return
      isDone = true
      world.files.set(FILE, one.changeOnRetry!(world.files.get(FILE) ?? ''))
      world.mtime += 1
    }
  }
  if (one.changeAfterWrite !== undefined) {
    const stale = one.changeAfterWrite(world.files.get(FILE) ?? '')
    world.afterWrite = one.keepTick === true ? () => one.changeAfterWrite!(world.files.get(FILE) ?? '') : () => stale
  }
  await ui.press({ key: key! })
  world.afterRead = undefined
  world.afterWrite = undefined

  return { world, ui, key: key!, drawn }
}

const expectRefused = async (world: World, ui: Ui, key: string, file: string, step: string, notice = ZH_TW.boardTickGone): Promise<void> => {
  expect(world.files.get(FILE)).toBe(file)
  expect(journalOf(world)).not.toContain(` · ${step}\n`)
  expect(besideButton(await ui.findAll({ type: 'Box' }), key)).toContain(notice)
}

const removeEarlier = (text: string): string => text.replace('- [ ] Earlier line\n', '')
const TWIN_STEPS = '## Demo\n### Other\n- [ ] Earlier line\n### Checklist\n- [ ] Same step\n- [ ] Same step\n'
const CHECKLIST = firstOf(/::Checklist(?:#\d+)?$/)
const CHECKLIST_TICK = firstOf(/::Checklist(?:#\d+)?::tick$/)

test('a pane tick is refused when a line removed above moves an identical sibling onto the drawn line', async ($, on) => {
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, change: removeEarlier })
  await expectRefused(world, ui, key, removeEarlier(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a pane tick is refused when a line added above moves the drawn step away from its identical sibling', async ($, on) => {
  const added = (text: string): string => text.replace('- [ ] Earlier line\n', '- [ ] Earlier line\n- [ ] Added line\n')
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, change: added })
  await expectRefused(world, ui, key, added(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a pane tick does not move to the identical sibling once another writer ticked the drawn step', async ($, on) => {
  const ticked = (text: string): string => text.replace('### Checklist\n- [ ] Same step\n', '### Checklist\n- [x] Same step\n')
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, change: ticked })
  await expectRefused(world, ui, key, ticked(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a pane tick does not move to the identical sibling once the drawn step was deleted', async ($, on) => {
  const deleted = (text: string): string => text.replace('### Checklist\n- [ ] Same step\n', '### Checklist\n')
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, change: deleted })
  await expectRefused(world, ui, key, deleted(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a retried pane tick that reads a newer file refuses instead of ticking the identical sibling', async ($, on) => {
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, changeOnRetry: removeEarlier })
  await expectRefused(world, ui, key, removeEarlier(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a pane tick written over by a stale snapshot that moved its identical sibling reports the tick gone and journals nothing', async ($, on) => {
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, changeAfterWrite: removeEarlier })
  await expectRefused(world, ui, key, removeEarlier(TWIN_STEPS), 'Same step')
  await ui.unmount()
})

test('a pane tick still counts when a stale snapshot that kept every line in place changed text above it', async ($, on) => {
  const edited = (text: string): string => text.replace('- [ ] Earlier line\n', '- [ ] Earlier line, reworded\n')
  const { world, ui } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK, changeAfterWrite: edited, keepTick: true })
  expect(world.files.get(FILE)).toMatch(/^## Demo\n### Other\n- \[ \] Earlier line, reworded\n### Checklist\n- \[x\] Same step[^\n]*\n- \[ \] Same step\n$/)
  expect(journalOf(world).split(' · Same step\n')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('Same step') })).toBeDefined()
  await ui.unmount()
})

test('a pane tick still counts when a stale snapshot that kept it reworded another step of the same task', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [ ] First step\n- [ ] Second step\n'
  const reworded = (text: string): string => text.replace('- [ ] Second step\n', '- [ ] Second step, reworded\n')
  const { world, ui } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, changeAfterWrite: reworded, keepTick: true })
  expect(world.files.get(FILE)).toMatch(/### Checklist\n- \[x\] First step[^\n]*\n- \[ \] Second step, reworded\n$/)
  expect(journalOf(world).split(' · First step\n')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('First step') })).toBeDefined()
  await ui.unmount()
})

test('a pane tick is reported gone when a stale snapshot that kept it gave its line to another task', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [x] Done step\n- [ ] Next step\n'
  const split = (text: string): string => text.replace(/- \[x\] Done step[^\n]*\n/, '### Follow-up\n')
  const { world, ui } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, changeAfterWrite: split, keepTick: true })
  expect(world.files.get(FILE)).toMatch(/### Checklist\n### Follow-up\n- \[x\] Next step[^\n]*\n$/)
  expect(journalOf(world)).not.toContain(' · Next step\n')
  // The Checklist row is gone with the step it lost, so the notice is no longer beside its button.
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTickGone })).toBeDefined()
  await ui.unmount()
})

test('a pane tick is refused when an identical sibling step appeared after the draw', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [ ] Same step\n- [ ] Other step\n'
  const grown = (text: string): string => text.replace('### Checklist\n', '### Checklist\n- [ ] Same step\n')
  const { world, ui, key } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: grown })
  await expectRefused(world, ui, key, grown(before), 'Same step')
  await ui.unmount()
})

test('a pane tick still lands on the drawn step after the done date was stamped on an earlier step', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [x] Done step\n- [ ] Next step\n'
  // The board dates a done step on its own; another date stands for a stamp written after the draw.
  const stamped = (text: string): string => text.replace(/- \[x\] Done step[^\n]*\n/, '- [x] Done step <!-- done 2026-10-15 -->\n')
  const { world, ui, drawn } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: stamped })
  expect(stamped(drawn)).not.toBe(drawn)
  expect(world.files.get(FILE)).toMatch(/- \[x\] Done step <!-- done 2026-10-15 -->\n- \[x\] Next step[^\n]*\n$/)
  expect(journalOf(world).split(' · Next step\n')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('Next step') })).toBeDefined()
  await ui.unmount()
})

const TWIN_TASKS = '## Demo\n### Checklist\n- [ ] Same step\n\n### Checklist\n- [ ] Same step\n'

test('a pane tick does not move to the twin task once the drawn task was removed', async ($, on) => {
  const removed = (text: string): string => text.replace('### Checklist\n- [ ] Same step\n\n', '')
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_TASKS, open: CHECKLIST, press: CHECKLIST_TICK, change: removed })
  await expectRefused(world, ui, key, removed(TWIN_TASKS), 'Same step')
  await ui.unmount()
})

test('a pane tick is refused when an identical twin task appeared above after the draw', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [ ] Same step\n'
  const twinned = (text: string): string => text.replace('## Demo\n', '## Demo\n### Checklist\n- [ ] Same step\n\n')
  const { world, ui, key } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: twinned })
  await expectRefused(world, ui, key, twinned(before), 'Same step')
  await ui.unmount()
})

test('a pane tick between twin tasks is refused once a done date tells them apart after the draw', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [x] Done step\n- [ ] Same step\n\n### Checklist\n- [x] Done step\n- [ ] Same step\n'
  const stamped = (text: string): string => text.replace(/- \[x\] Done step[^\n]*\n(- \[ \] Same step\n)$/, '- [x] Done step <!-- done 2026-10-15 -->\n$1')
  const { world, ui, key, drawn } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: stamped })
  expect(stamped(drawn)).not.toBe(drawn)
  await expectRefused(world, ui, key, stamped(drawn), 'Same step')
  await ui.unmount()
})

const TWIN_QUESTIONS = '## Demo\n### Other\n- [ ] Earlier line\n### Checklist\n- [?] Same question\n- [?] Same question\n'
const QUESTION_DONE = firstOf(/::Checklist::\d+::done$/)

test('Done on a manual question is refused when a removed line moves an identical question onto the drawn line', async ($, on) => {
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_QUESTIONS, press: QUESTION_DONE, change: removeEarlier })
  await expectRefused(world, ui, key, removeEarlier(TWIN_QUESTIONS), 'Same question')
  await ui.unmount()
})

test('Done on a manual question ticks the drawn question and leaves its identical sibling open', async ($, on) => {
  const { world, ui } = await pressAfter($, on, { before: TWIN_QUESTIONS, press: QUESTION_DONE })
  expect(world.files.get(FILE)).toMatch(/### Checklist\n- \[x\] Same question[^\n]*\n- \[\?\] Same question\n$/)
  expect(journalOf(world).split(' · Same question\n')).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('Same question') })).toBeDefined()
  await ui.unmount()
})

// Steps right under a project, with no task heading, and a task under no project at all.
const firstTick = firstOf(/::tick$/)
const firstRow = (project: string) => (keys: readonly string[]): string | undefined => keys.filter(key => key.startsWith(`${project}::`) && key.split('::').length === 2).sort()[0]

test('an untitled task ticks only its drawn step when nothing moved', async ($, on) => {
  const before = '## Demo\n- [ ] Same step\n- [ ] Same step\n\n## Other\n- [ ] Earlier line\n'
  const ticked = await pressAfter($, on, { before, open: firstRow('Demo'), press: firstTick })
  expect(ticked.world.files.get(FILE)).toMatch(/^## Demo\n- \[x\] Same step[^\n]*\n- \[ \] Same step\n/)
  expect(journalOf(ticked.world).split(' · Same step\n')).toHaveLength(2)
  await ticked.ui.unmount()
})

test('an untitled task refuses its tick once a removed line above moves its identical sibling onto the drawn line', async ($, on) => {
  const before = '## Other\n- [ ] Earlier line\n\n## Demo\n- [ ] Same step\n- [ ] Same step\n'
  const { world, ui, key } = await pressAfter($, on, { before, open: firstRow('Demo'), press: firstTick, change: removeEarlier })
  await expectRefused(world, ui, key, removeEarlier(before), 'Same step')
  await ui.unmount()
})

test('a localized uncategorized task ticks only its drawn step in English when nothing moved', async ($, on) => {
  const before = '### Other\n- [ ] Earlier line\n### Checklist\n- [ ] Same step\n- [ ] Same step\n'
  const ticked = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, lang: 'en' })
  expect(ticked.world.files.get(FILE)).toMatch(/### Checklist\n- \[x\] Same step[^\n]*\n- \[ \] Same step\n$/)
  expect(besideButton(await ticked.ui.findAll({ type: 'Box' }), ticked.key)).toContain(EN.boardTicked('Same step'))
  await ticked.ui.unmount()
})

test('a localized uncategorized task refuses its tick in English once a removed line moves its identical sibling', async ($, on) => {
  const before = '### Other\n- [ ] Earlier line\n### Checklist\n- [ ] Same step\n- [ ] Same step\n'
  const { world, ui, key } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: removeEarlier, lang: 'en' })
  await expectRefused(world, ui, key, removeEarlier(before), 'Same step', EN.boardTickGone)
  await ui.unmount()
})

test('a pane tick still lands on the drawn step after a line was added below its task', async ($, on) => {
  const before = '## Demo\n### Checklist\n- [ ] Next step\n'
  const below = (text: string): string => `${text}\n### Later\n- [ ] Added below\n`
  const { world, ui } = await pressAfter($, on, { before, open: CHECKLIST, press: CHECKLIST_TICK, change: below })
  expect(world.files.get(FILE)).toMatch(/### Checklist\n- \[x\] Next step[^\n]*\n\n### Later\n- \[ \] Added below\n$/)
  expect(await ui.find({ type: 'Text', text: ZH_TW.boardTicked('Next step') })).toBeDefined()
  await ui.unmount()
})

test('a pane tick with an identical sibling ticks only the drawn step when nothing moved', async ($, on) => {
  const { world, ui, key } = await pressAfter($, on, { before: TWIN_STEPS, open: CHECKLIST, press: CHECKLIST_TICK })
  expect(world.files.get(FILE)).toMatch(/### Checklist\n- \[x\] Same step[^\n]*\n- \[ \] Same step\n$/)
  expect(journalOf(world).split(' · Same step\n')).toHaveLength(2)
  expect(besideButton(await ui.findAll({ type: 'Box' }), key)).toContain(ZH_TW.boardTicked('Same step'))
  await ui.unmount()
})

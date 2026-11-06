import { PANE, PROPS, engineBeneath, expect, start, test, type World } from './pane-helpers'

const worldOf = (): World => ({ files: new Map(), mtime: 1, hasTasks: false, store: { lang: 'en', autoConnectOff: true }, reply: () => 'TITLE: Choose the colors\nCONTEXT: -\nDONE: -\nNEXT: -\nASK: -' })

test('the pane lists a native question\'s options and says where to answer it, with no answer button or reply box', async ($, on) => {
  const world = worldOf()
  engineBeneath(on, world)
  let release!: () => void
  const answered = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    entered()
    await answered
    return { result: { answers: { 'Blue or green?': 'Blue' } } }
  })
  await start($, 'Choose the colors')
  const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'synthetic-pane-native', questions: [{ question: 'Blue or green?', header: 'Color', options: [{ label: 'Blue', description: 'Blue palette' }, { label: 'Green', description: 'Green palette' }], multiSelect: false }] })
  await waiting
  try {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    expect(await ui.find({ type: 'Text', text: "Answer in Claude Code's window." })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· Green' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Blue' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'Green' })).toBeUndefined()
    // The pane's own box stays; no reply box is offered for the question.
    expect((await ui.findAll({ type: 'Input' })).map(input => input.key)).toEqual(['ask'])
  } finally {
    release()
    await call
  }
})

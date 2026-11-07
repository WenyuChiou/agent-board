import { expect } from 'claude-code/testing'
import { DARK, LIGHT } from '../hooks/palette'
import { EN, FILE, PANE, PROPS, TIDY, engineBeneath, pressNodes, pressTexts, test } from './pane-helpers'
import type { World } from './pane-helpers'

// #1085: the pane draws one cell per step in the person's style, and `/progress style` writes the
// one key every surface reads.
const SETTINGS = FILE.replace(/\.md$/, '-settings.json')
const board = (steps: string): string =>
  `# Progress\n\n## Demo\n<!-- auto session=10000001 agent=codex state=waiting updated=2026-10-16T12:00:00Z -->\n### Synthetic plan\n${steps}<!-- /auto session=10000001 -->\n`
const SEVEN = '- [x] One\n- [x] Two\n- [x] Three\n- [x] Four\n- [~] Five\n- [ ] Six\n- [ ] Seven\n'

type Drawn = { type: string; text?: string; props?: { color?: string; bold?: boolean } }

test('#1085: a pane row shows a cell per step with n/m beside it, in the style /progress style picks', async ($, on) => {
  const world: World = { files: new Map([[FILE, board(SEVEN)]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const texts = async (): Promise<Drawn[]> => pressNodes(await ui.drawn() as never).filter(node => node.type === 'Text') as Drawn[]
    const pieces = (nodes: Drawn[]): string => nodes.map(node => pressTexts(node as never).join('')).join('')
    const drawn = await texts()
    expect(pieces(drawn)).toContain(' ━━━━╸── 4/7')
    // Ink by default: done cells in the muted ink, the current cell in the terminal's own bold ink.
    const done = drawn.find(node => pressTexts(node as never).join('').endsWith('━━━━'))
    expect([DARK.muted, LIGHT.muted]).toContain(done?.props?.color)
    const current = drawn.find(node => pressTexts(node as never).join('') === '╸')
    expect(current?.props?.bold).toBe(true)

    const unknown = await $.command.run({ ...TIDY, args: 'style pink' })
    expect(JSON.stringify(unknown)).toContain(EN.barStyleUnknown)
    expect(world.files.has(SETTINGS)).toBe(false)
    const picked = await $.command.run({ ...TIDY, args: 'style blue' })
    expect(JSON.stringify(picked)).toContain(EN.barStyleSet(EN.barStyleBlue))
    expect(JSON.parse(world.files.get(SETTINGS) ?? '{}')).toEqual({ style: 'blue' })
    const blue = (await texts()).find(node => pressTexts(node as never).join('').endsWith('━━━━'))
    expect([DARK.accent, LIGHT.accent]).toContain(blue?.props?.color)

    // A pick made elsewhere (the page, the terminal board) shows at the next draw; other keys stay.
    world.files.set(SETTINGS, '{"historyDays":3,"style":"green"}')
    const green = await texts()
    expect([DARK.done, LIGHT.done]).toContain(green.find(node => pressTexts(node as never).join('').endsWith('━━━━'))?.props?.color)
  } finally { await ui.unmount() }
})

test('#1085: a one-step task shows its count alone, with no bar', async ($, on) => {
  const world: World = { files: new Map([[FILE, board('- [~] Only step\n')]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const text = pressNodes(await ui.drawn() as never).filter(node => node.type === 'Text').map(node => pressTexts(node as never).join('')).join('|')
    expect(text).toContain(' 0/1')
    expect(text).not.toMatch(/[━╸─]/)
  } finally { await ui.unmount() }
})

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
  const clock = engineBeneath(on, world)
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

    // A pick made elsewhere (the page, the terminal board) shows after the next poll.
    world.files.set(SETTINGS, '{"historyDays":3,"style":"green"}')
    world.mtime += 1
    await clock.advance(2100)
    const green = await texts()
    expect([DARK.done, LIGHT.done]).toContain(green.find(node => pressTexts(node as never).join('').endsWith('━━━━'))?.props?.color)
  } finally { await ui.unmount() }
})

// #1276: the plugin's own path reads and writes through the guarded scripts, so a link or a folder at the
// settings path is refused with its own words and nothing is written. Before the fix `/progress style`
// read and wrote the file with the host's calls and reported the style as set.
test('#1276: /progress style refuses a settings file that is a link or a folder, and says so', async ($, on) => {
  const world: World = { files: new Map([[FILE, board(SEVEN)], [SETTINGS, '{"style":"green"}']]), unsafeFiles: new Set([SETTINGS]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const refused = JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))
  expect(refused).toContain(EN.barStyleUnsafe)
  expect(refused).not.toContain(EN.barStyleSet(EN.barStyleBlue))
  expect(world.files.get(SETTINGS)).toBe('{"style":"green"}')
  world.unsafeFiles = new Set()
  expect(JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))).toContain(EN.barStyleSet(EN.barStyleBlue))
  expect(JSON.parse(world.files.get(SETTINGS) ?? '{}')).toEqual({ style: 'blue' })
})

// #1339 (codex_166 finding 5): a lock held by another save stops /progress style with the lock's full path,
// as the write script printed it; output cut short gives the general failure, never a half path.
test('#1339: /progress style names a held settings lock, and a cut-short path gives the general failure', async ($, on) => {
  const lock = `${SETTINGS}.agent-board.lock`
  const world: World = { files: new Map([[FILE, board(SEVEN)], [SETTINGS, '{"style":"green"}']]), lockedFiles: new Map([[SETTINGS, { stdout: lock }]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const held = JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))
  expect(held).toContain(JSON.stringify(EN.settingsLocked(lock)).slice(1, -1))
  expect(held).not.toContain(EN.barStyleSet(EN.barStyleBlue))
  expect(world.files.get(SETTINGS)).toBe('{"style":"green"}')
  world.lockedFiles = new Map([[SETTINGS, { stdout: lock.slice(0, 8), isTruncated: true }]])
  const cut = JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))
  expect(cut).toContain(EN.pressFailed)
  expect(cut).not.toContain('If no save is running')
  expect(world.files.get(SETTINGS)).toBe('{"style":"green"}')
  world.lockedFiles = undefined
  expect(JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))).toContain(EN.barStyleSet(EN.barStyleBlue))
})

test('#1339: /progress style keeps a saved style and names a lock it could not remove', async ($, on) => {
  const lock = `${SETTINGS}.agent-board.lock`
  const world: World = { files: new Map([[FILE, board(SEVEN)], [SETTINGS, '{"style":"green"}']]), leftLocks: new Map([[SETTINGS, { stdout: lock }]]), mtime: 1, hasTasks: true, store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const saved = JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))
    expect(saved).toContain(EN.barStyleSet(EN.barStyleBlue))
    expect(saved).toContain(EN.settingsLockLeft(lock))
    expect(JSON.parse(world.files.get(SETTINGS) ?? '{}')).toEqual({ style: 'blue' })
    const done = pressNodes(await ui.drawn() as never).find(node => pressTexts(node as never).join('').endsWith('━━━━')) as Drawn | undefined
    expect([DARK.accent, LIGHT.accent]).toContain(done?.props?.color)
    world.leftLocks = new Map([[SETTINGS, { stdout: lock.slice(0, 8), isTruncated: true }]])
    const cut = JSON.stringify(await $.command.run({ ...TIDY, args: 'style green' }))
    expect(cut).toContain(EN.pressFailed)
    expect(cut).not.toContain('If no save is running')
  } finally { await ui.unmount() }
})

// #1276, Codex on #1339: the style poll and the history-days read used the host's read, which waits on a FIFO.
// They now read through the guarded script; the host never reads the settings file, and the pick still shows.
test('#1276: the style poll reads the settings file through the guarded script, never the host read', async ($, on) => {
  const world: World = { files: new Map([[FILE, board(SEVEN)], [SETTINGS, '{"style":"green"}']]), mtime: 1, hasTasks: true, reads: [], ran: [], store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  const clock = engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    world.mtime += 1
    await clock.advance(2100)
    expect(world.reads).not.toContain(SETTINGS)
    expect(world.ran?.some(argv => argv.includes(SETTINGS))).toBe(true)
    // A path that is a link or a folder reads as no file: the pick falls back to the default and nothing waits.
    world.unsafeFiles = new Set([SETTINGS])
    world.mtime += 1
    await clock.advance(2100)
    expect(world.reads).not.toContain(SETTINGS)
  } finally { await ui.unmount() }
})

// #1276, Codex on #1339: the settings JSON went in the process arguments, which other users can list.
test('#1276: /progress style hands the settings text to the script on stdin, not in its arguments', async ($, on) => {
  const world: World = { files: new Map([[FILE, board(SEVEN)], [SETTINGS, '{"historyDays":3,"lang":"en"}']]), mtime: 1, hasTasks: true, settingsWrites: [], store: { lang: 'en', autoConnectOff: true, opened: ['others'] } }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/persona_framework', surface: 'desktop', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ ...TIDY, args: 'style blue' }))).toContain(EN.barStyleSet(EN.barStyleBlue))
  expect(world.settingsWrites?.length).toBe(1)
  const [write] = world.settingsWrites ?? []
  expect(write?.argv.join('\n')).not.toContain('historyDays')
  expect(write?.argv.join('\n')).not.toContain('"style"')
  const given = JSON.parse(write?.stdin ?? '{}') as { next?: string; base?: string }
  expect(given.base).toBe('{"historyDays":3,"lang":"en"}')
  expect(JSON.parse(given.next ?? '{}')).toEqual({ historyDays: 3, lang: 'en', style: 'blue' })
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

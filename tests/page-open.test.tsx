import { expect, test } from 'claude-code/testing'
import { EN, FILE, LIVE_SCRIPT, PANE, PROPS, TIDY, engineBeneath, installedBoard } from './pane-helpers'
import type { World } from './pane-helpers'

test('the progress open command and the pane page button request a browser and retain its fallback link', async ($, on) => {
  const url = 'http://127.0.0.1:34567/?t=synthetic-page-open'
  const world: World = {
    files: new Map([[FILE, '## demo\n### Synthetic task\n- [ ] Continue\n'], [LIVE_SCRIPT, installedBoard()]]),
    mtime: 1, hasTasks: true, liveCalls: [], liveOutput: `${EN.serveAt(url)}\n`,
    store: { autoConnectOff: true, lang: 'en', inboxDone: {} },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  const opened = await $.command.run({ ...TIDY, args: 'open' })
  expect(opened.text).toContain(`<${url}>`)
  expect(world.liveCalls?.at(-1)?.argv).not.toContain('--no-open')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
  try {
    const before = world.liveCalls?.length ?? 0
    await ui.press({ key: 'page' })
    expect(world.liveCalls?.length).toBe(before + 1)
    expect(world.liveCalls?.at(-1)?.argv).not.toContain('--no-open')
    expect(JSON.stringify(await ui.drawn())).toContain(url)
  } finally { await ui.unmount() }
})

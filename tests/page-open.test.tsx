import { expect, test } from 'claude-code/testing'
import { HOOK_VERSION } from '../hooks/hook-safety'
import { ZH_TW } from '../hooks/i18n'
import { ZH_CN } from '../hooks/strings-zh-cn'
import { EN, FILE, LIVE_SCRIPT, PANE, PROPS, TIDY, engineBeneath, installedBoard } from './pane-helpers'
import type { World } from './pane-helpers'

test('the progress open command runs the board npm setup wrote, whose first line also names the Codex folder, and still installs a changed one first', async ($, on) => {
  const url = 'http://127.0.0.1:34567/?t=synthetic-npm-board'
  const body = installedBoard().slice(installedBoard().indexOf('\n') + 1)
  const head = { hookVersion: HOOK_VERSION, path: FILE, codexRoot: '/home/me/.agent-board', lang: 'en' }
  const npmBoard = `globalThis.AGENT_BOARD = ${JSON.stringify(head)}\n${body}`
  const world: World = {
    files: new Map([[FILE, '## demo\n### Synthetic task\n- [ ] Continue\n'], [LIVE_SCRIPT, npmBoard]]),
    mtime: 1, hasTasks: true, liveCalls: [], liveOutput: `${EN.serveAt(url)}\n`,
    store: { autoConnectOff: true, lang: 'en', inboxDone: {} },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ ...TIDY, args: 'open' })).text).toContain(`<${url}>`)
  const changed = [
    `globalThis.AGENT_BOARD = ${JSON.stringify(head)};process.exit(1)\n${body}`,
    `globalThis.AGENT_BOARD = ${JSON.stringify({ ...head, extra: 'x' })}\n${body}`,
    `globalThis.AGENT_BOARD = ${JSON.stringify({ ...head, path: '/home/me/other/progress.md' })}\n${body}`,
    `globalThis.AGENT_BOARD = ${JSON.stringify(head)}\n${body}\n// changed`,
  ]
  for (const file of changed) {
    world.files.set(LIVE_SCRIPT, file)
    const calls = world.liveCalls?.length ?? 0
    expect((await $.command.run({ ...TIDY, args: 'open' })).text).toContain(EN.livePageNeedsInstall)
    expect(world.liveCalls?.length).toBe(calls)
  }
})

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

for (const [code, s] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]] as const) {
  test(`when a browser window opens (${code}), /progress open omits URLs and ?t= while the fallback keeps only the one-use link`, async ($, on) => {
    const world: World = {
      files: new Map([[FILE, '## demo\n### Synthetic task\n- [ ] Continue\n'], [LIVE_SCRIPT, installedBoard()]]),
      mtime: 1, hasTasks: true, liveCalls: [], liveOutput: `${s.boardPageWindowOpened}\n`,
      store: { autoConnectOff: true, lang: code, inboxDone: {} },
    }
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })

    const opened = await $.command.run({ ...TIDY, args: 'open' })
    expect(opened.text).toBe(s.boardPageWindowOpened)
    expect(opened.text).not.toContain('http://')
    expect(opened.text).not.toContain('?t=')

    const openUrl = 'http://127.0.0.1:34567/open/synthetic-one-use-code'
    world.liveOutput = `${s.serveAt(openUrl)}\n`
    const fallback = await $.command.run({ ...TIDY, args: 'open' })
    expect(fallback.text).toContain(`<${openUrl}>`)
    expect(fallback.text).not.toContain('?t=')
  })
}

test("the plugin repeats the board's refusal in each language", async ($, on) => {
  const world: World = {
    files: new Map([[FILE, '## demo\n### Synthetic task\n- [ ] Continue\n'], [LIVE_SCRIPT, installedBoard()]]),
    mtime: 1, hasTasks: true, liveCalls: [], liveFailure: 'exit', liveOutput: '',
    store: { autoConnectOff: true, lang: 'en', inboxDone: {} },
  }
  engineBeneath(on, world)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  for (const [code, s] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]] as const) {
    await $.command.run({ ...TIDY, args: `lang ${code}` })
    // The board says what to do next (run it again in a moment, or close the older page); the pane
    // passes that line on as it is, with nothing of its own about starting the page again.
    for (const refusal of [s.serveBusy, s.serveKeptNoLink]) {
      world.liveOutput = `${refusal}\n`
      const reply = await $.command.run({ ...TIDY, args: 'open' })
      expect(reply.text).toBe(refusal)
      expect(reply.text).not.toContain('http')
      expect(reply.text).not.toContain('/open/')
      expect(reply.text).not.toContain('--serve')
      expect(reply.text).not.toContain(s.livePageFallback)
    }
  }
})

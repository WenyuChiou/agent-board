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

// The words a drawn pane holds, one entry for each text the pane drew (and each button's label), so a
// test can ask for a whole sentence rather than a piece of one.
const leavesOf = (node: unknown): string[] => {
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(leavesOf)
  if (node === null || typeof node !== 'object') return []
  const element = node as { type?: string; props?: { label?: string }; children?: unknown[] }
  const label = (element.type === 'Button' || element.type === 'Link') && element.props?.label !== undefined ? [element.props.label] : []
  return [...label, ...(element.children ?? []).flatMap(leavesOf)]
}

// Any way of writing where a page lives: a scheme, an IPv4 or IPv6 address, a port, a host name, the
// one-use path or the old token.
const ADDRESS = /https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\blocalhost\b|\[[0-9a-f]*:[0-9a-f:]*\]|:\d{4,5}\b|\/open\/|[?&#]t=/i

const wordsOpen = (code: 'en' | 'zh-TW' | 'zh-CN', output: string, stderr?: string): World => ({
  files: new Map([[FILE, '## demo\n### Synthetic task\n- [ ] Continue\n'], [LIVE_SCRIPT, installedBoard()]]),
  mtime: 1, hasTasks: true, liveCalls: [], liveOutput: output,
  ...(stderr === undefined ? {} : { liveStderr: stderr }),
  store: { autoConnectOff: true, lang: code, inboxDone: {} },
})

const PORT_URL = 'http://127.0.0.1:34567/open/synthetic-one-use-note'

for (const [code, s] of [['en', EN], ['zh-TW', ZH_TW], ['zh-CN', ZH_CN]] as const) {
  // What the board prints when the window it opened loaded its page: one sentence, no address.
  const windowOpened = `${s.boardPageWindowOpened}\n`

  test(`/progress open says exactly the window-opened sentence, with no address (${code})`, async ($, on) => {
    const world = wordsOpen(code, windowOpened)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    const opened = await $.command.run({ ...TIDY, args: 'open' })
    expect(opened.text).toBe(s.boardPageWindowOpened)
    expect(ADDRESS.test(opened.text)).toBe(false)
  })

  test(`/agent-board says exactly the window-opened sentence, with no address (${code})`, async ($, on) => {
    const world = wordsOpen(code, windowOpened)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    const opened = await $.command.run({ ...TIDY, command: 'agent-board', args: '' })
    expect(opened.text).toBe(s.boardPageWindowOpened)
    expect(ADDRESS.test(opened.text)).toBe(false)
  })

  test(`the pane page button draws exactly the window-opened sentence, with no address (${code})`, async ($, on) => {
    const world = wordsOpen(code, windowOpened)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      await ui.press({ key: 'page' })
      const drawn = leavesOf(await ui.drawn())
      // The whole sentence is one drawn text, and nothing the pane drew names a page's address.
      expect(drawn.filter(text => text === s.boardPageWindowOpened).length).toBe(1)
      expect(JSON.stringify(drawn.filter(text => ADDRESS.test(text)))).toBe('[]')
    } finally { await ui.unmount() }
  })

  test(`/progress open keeps only the board's one-use link when no window opened, never a reusable token (${code})`, async ($, on) => {
    const openUrl = 'http://127.0.0.1:34567/open/synthetic-one-use-code'
    const world = wordsOpen(code, `${s.serveAt(openUrl)}\n`)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    const fallback = await $.command.run({ ...TIDY, args: 'open' })
    expect(fallback.text).toBe(`${s.boardPageOpened}\n<${openUrl}>`)
    expect(fallback.text).not.toContain('?t=')
  })

  // What became of the window, which the board writes on stderr beside its link: a window started
  // that was not seen to load, a page that looks open already, no browser, or over SSH how to forward
  // the page's port to the computer in front of the person.
  const notes: Array<[string, (url: string) => string]> = [
    ['a window started', s.boardPageLaunchedLink],
    ['a page already open', s.boardPageAlreadyOpenLink],
    ['no browser', s.serveBrowserNone],
    ['an SSH forward on a standard port', url => s.serveSshHint(34567, '203.0.113.9', url)],
    ['an SSH forward on another SSH port', url => s.serveSshHint(34567, '-p 2222 203.0.113.9', url)],
  ]

  test(`/progress open shows the board's note exactly, ssh -L forwarding note included, beside its one-use link (${code})`, async ($, on) => {
    const world = wordsOpen(code, `${s.serveAt(PORT_URL)}\n`)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    for (const [what, note] of notes) {
      world.liveStderr = `SYNTHETIC_STARTUP_DETAIL\n${note(PORT_URL)}\n`
      const reply = await $.command.run({ ...TIDY, args: 'open' })
      expect(`${what}: ${reply.text}`).toBe(`${what}: ${s.boardPageOpened}\n${note(PORT_URL).replace(PORT_URL, `<${PORT_URL}>`)}`)
    }
    // A note naming another link is not about this one: the link alone, as before.
    world.liveStderr = `${s.boardPageLaunchedLink('http://127.0.0.1:34567/open/another-synthetic-code')}\n`
    expect((await $.command.run({ ...TIDY, args: 'open' })).text).toBe(`${s.boardPageOpened}\n<${PORT_URL}>`)
  })

  test(`/agent-board shows the board's note exactly, ssh -L forwarding note included, beside its one-use link (${code})`, async ($, on) => {
    const world = wordsOpen(code, `${s.serveAt(PORT_URL)}\n`)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    for (const [what, note] of notes) {
      world.liveStderr = `SYNTHETIC_STARTUP_DETAIL\n${note(PORT_URL)}\n`
      const reply = await $.command.run({ ...TIDY, command: 'agent-board', args: '' })
      expect(`${what}: ${reply.text}`).toBe(`${what}: ${s.boardPageOpened}\n${note(PORT_URL).replace(PORT_URL, `<${PORT_URL}>`)}`)
    }
  })

  test(`the pane page button draws the board's note exactly, ssh -L forwarding note included, beside its one-use link (${code})`, async ($, on) => {
    const world = wordsOpen(code, `${s.serveAt(PORT_URL)}\n`)
    engineBeneath(on, world)
    await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PROPS })
    try {
      for (const [what, note] of notes) {
        world.liveStderr = `SYNTHETIC_STARTUP_DETAIL\n${note(PORT_URL)}\n`
        await ui.press({ key: 'page' })
        const drawn = leavesOf(await ui.drawn())
        // The note is one drawn text, and it is the only one that starts with the headline.
        expect(`${what}: ${JSON.stringify(drawn.filter(text => text.startsWith(s.boardPageOpened)))}`).toBe(`${what}: ${JSON.stringify([`${s.boardPageOpened}\n${note(PORT_URL).replace(PORT_URL, `<${PORT_URL}>`)}`])}`)
      }
    } finally { await ui.unmount() }
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

import { expect, test } from 'claude-code/testing'
import { boardAgents, boardItems, boardKey, boardLayout, boardScreen, boardText, displayColumns, emptyBoardState, fingerprint, frame, nearest256, pinned, routesOf, terminalLook } from '../hooks/board'
import type { AnswerRoute } from '../hooks/board'
import { DARK, LIGHT } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { STRINGS } from '../hooks/strings'
import { buildView } from '../hooks/view'

// The terminal board (#545): the page's colours, order and keys. All data is made up.
const NOW = Date.parse('2026-10-30T12:00:00Z')
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
const BOARD = `# Progress

## docs-site
<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=${at(5)} -->
### Ship the synthetic docs
- [x] Write the pages
- [?] Publish them to staging, OK?
- [ ] Announce
<!-- /auto session=a1b2c3d4 -->

## sample-api
<!-- auto session=e5f6a7b8 agent=claude state=working updated=${at(50)} -->
### Add a synthetic health check
- [x] Read the routes
- [~] Write the handler
- [ ] Add a test
<!-- /auto session=e5f6a7b8 -->

## notes
### Tidy the synthetic notes
- [ ] Sort them
`
const viewOf = (file: string, lang: keyof typeof STRINGS = 'en') => buildView(parseProgress(file), [], null, NOW, 0, {}, STRINGS[lang])
const ESC = '\u001b'
const sgr = (hex: string): string => `38;5;${nearest256(hex)}`

test('the terminal board paints with the page palette in 24-bit and 256 colours and never uses the terminal dim', () => {
  const s = STRINGS.en
  const view = viewOf(BOARD)
  const state = pinned(emptyBoardState, boardItems(view, []))
  for (const theme of ['dark', 'light'] as const) {
    const palette = theme === 'dark' ? DARK : LIGHT
    const deep = boardScreen(view, [], state, s, { width: 80, isColor: true, depth: 'truecolor', theme })
    const [r, g, b] = [1, 3, 5].map(i => parseInt(palette.waiting.slice(i, i + 2), 16))
    expect(deep).toContain(`${ESC}[1;38;2;${r};${g};${b}m● 1 waiting`)
    const near = boardScreen(view, [], state, s, { width: 80, isColor: true, depth: '256', theme })
    expect(near).toContain(`${ESC}[1;${sgr(palette.waiting)}m● 1 waiting`)
    // Secondary text is the palette's muted colour, project names bold in the project colour.
    expect(near).toContain(`${ESC}[${sgr(palette.muted)}m`)
    expect(near).toContain(`${ESC}[1;${sgr(palette.project)}mnotes`)
    for (const out of [deep, near, boardText(view, [], s, { width: 80, isColor: true, depth: '256', theme })]) {
      expect(out).not.toMatch(/\u001b\[(?:\d+;)*2m/)
      expect(out).not.toMatch(/\u001b\[(?:3[0-7]|9[0-7])m/)
    }
  }
  // The nearest of 256 is the cube or the greys, whichever is closer.
  expect(nearest256('#000000')).toBe(16)
  expect(nearest256('#ffffff')).toBe(231)
  expect(nearest256('#808080')).toBe(244)
  // What the terminal says of itself picks the look.
  expect(terminalLook({ COLORTERM: 'truecolor' }, [], true)).toEqual({ isColor: true, depth: 'truecolor', theme: 'dark' })
  expect(terminalLook({ COLORTERM: '24bit', COLORFGBG: '0;15' }, [], true)).toEqual({ isColor: true, depth: 'truecolor', theme: 'light' })
  expect(terminalLook({}, ['--theme', 'light'], true).theme).toBe('light')
  expect(terminalLook({ COLORFGBG: '15;0' }, [], true).theme).toBe('dark')
  expect(terminalLook({ NO_COLOR: '1' }, [], true).isColor).toBe(false)
  expect(terminalLook({}, ['--no-color'], true).isColor).toBe(false)
  expect(terminalLook({}, [], false).isColor).toBe(false)
  expect(terminalLook({ FORCE_COLOR: '1' }, [], false)).toEqual({ isColor: true, depth: '256', theme: 'dark' })
  expect(terminalLook({ FORCE_COLOR: '0' }, [], false).isColor).toBe(false)
  expect(terminalLook({ NO_COLOR: '1', FORCE_COLOR: '1' }, [], false).isColor).toBe(false)
})

test('the terminal board counts wide symbols as two columns in Chinese', () => {
  expect(displayColumns('● ✓ ⚑ ◐ … —')).toBe(11)
  expect(displayColumns('● ✓ ⚑ ◐ … —', true)).toBe(17)
  expect(displayColumns('進度 abc', true)).toBe(8)
  const long = BOARD.replace('Add a synthetic health check', '加一個合成的健康檢查 ● ✓ ⚑ ◐ … — 再加一些字讓這一行一定比八十欄還長很多很多很多很多')
  for (const lang of ['zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    const view = viewOf(long, lang)
    for (const out of [boardScreen(view, [], pinned(emptyBoardState, boardItems(view, [])), s, { width: 80, isColor: false }), boardText(view, [], s, { width: 80, isColor: false })]) {
      for (const line of out.split('\n')) expect(displayColumns(line, true)).toBeLessThanOrEqual(80)
    }
  }
  // English keeps one column for them.
  const view = viewOf(long)
  const lines = boardScreen(view, [], emptyBoardState, STRINGS.en, { width: 80, isColor: false }).split('\n')
  expect(lines.some(line => displayColumns(line) > 74 && displayColumns(line, true) > 80)).toBe(true)
})

test('the terminal board redraws without clearing the screen and writes nothing when nothing changed', () => {
  const first = frame(null, 'Progress\nline two\n')
  expect(first).toBe(`${ESC}[HProgress${ESC}[K\nline two${ESC}[K${ESC}[J`)
  expect(first).not.toContain(`${ESC}[2J`)
  expect(frame('Progress\nline two\n', 'Progress\nline two\n')).toBeNull()
  expect(frame('Progress\nline two\n', 'Progress\nline 2\n')).toBe(`${ESC}[HProgress${ESC}[K\nline 2${ESC}[K${ESC}[J`)
  // Taller than the terminal: the last line (the keys) stays and the screen never scrolls.
  expect(frame(null, 'a\nb\nc\nd\nkeys\n', 3)).toBe(`${ESC}[Ha${ESC}[K\nb${ESC}[K\nkeys${ESC}[K${ESC}[J`)
  // The board itself has no clearing codes.
  const view = viewOf(BOARD)
  expect(boardScreen(view, [], emptyBoardState, STRINGS.en, { width: 80, isColor: true })).not.toContain(`${ESC}[2J`)
})

test('a terminal board taller than the screen moves its window to show the selected line the keys act on', () => {
  // The window ends on the focus when it fits, starts on it when it does not, and keeps the keys line.
  expect(frame(null, 'a\nb\nc\nd\nkeys\n', 3, [3, 3])).toBe(`${ESC}[Hc${ESC}[K\nd${ESC}[K\nkeys${ESC}[K${ESC}[J`)
  expect(frame(null, 'a\nb\nc\nd\nkeys\n', 3, [1, 3])).toBe(`${ESC}[Hb${ESC}[K\nc${ESC}[K\nkeys${ESC}[K${ESC}[J`)
  expect(frame(null, 'a\nb\nc\nd\nkeys\n', 3, [0, 0])).toBe(`${ESC}[Ha${ESC}[K\nb${ESC}[K\nkeys${ESC}[K${ESC}[J`)
  const s = STRINGS.en
  const tasks = Array.from({ length: 12 }, (_, n) => `### Synthetic task ${n + 1}\n- [ ] Step of task ${n + 1}\n`).join('')
  const view = viewOf(`# Progress\n\n## notes\n${tasks}`)
  const items = boardItems(view, [])
  const last = items.findIndex(item => item.type === 'row' && item.row.title === 'Synthetic task 12')
  const state = pinned({ ...emptyBoardState, selected: last }, items)
  const { screen, focus } = boardLayout(view, [], state, s, { width: 80, isColor: false })
  const shown = frame(null, screen, 24, focus) ?? ''
  // x ticks task 12's step, and task 12 is on the 24 rows the person sees.
  expect(boardKey(state, 'x', items, s).action).toMatchObject({ type: 'tick' })
  expect(shown).toContain('› Synthetic task 12')
  expect(shown).toContain('Step of task 12')
  expect(shown.split('\n').length).toBeLessThanOrEqual(24)
})

test('a yes/no or two-option question is answered with one key on the terminal board', () => {
  const s = STRINGS.en
  const file = `${BOARD}
## choices
<!-- auto session=0badcafe agent=codex state=waiting updated=${at(2)} -->
### Pick a synthetic window
- [?] 24 hours or 7 days?
<!-- /auto session=0badcafe -->
`
  const view = viewOf(file)
  const items = boardItems(view, [])
  const confirm = items.findIndex(item => item.type === 'ask' && item.ask.kind === 'confirm')
  const choose = items.findIndex(item => item.type === 'ask' && item.ask.kind === 'choose')
  const drawn = (selected: number) => pinned({ ...emptyBoardState, selected }, items)
  // With no session that takes it, the key copies, and the line says so.
  expect(boardKey(drawn(confirm), 'y', items, s).action).toEqual({ type: 'copy', text: s.yesAnswer })
  expect(boardKey(drawn(confirm), 'n', items, s).action).toEqual({ type: 'copy', text: s.noAnswer })
  expect(boardKey(drawn(choose), '2', items, s).action).toEqual({ type: 'copy', text: '7 days' })
  const copying = boardScreen(view, [], drawn(confirm), s, { width: 80, isColor: false })
  expect(copying).toContain(s.boardAnswerCopiesTo('y/n', 'Codex'))
  expect(copying).toContain(s.boardKeyConfirm)
  // Where the running page sends into a connected session, the same key sends.
  const item = items[confirm]!
  const route: AnswerRoute = { mode: 'connected', agent: 'codex', session: 's', asked: 'Publish them to staging, OK?', fp: fingerprint(item, items), delivery: { id: 'c1', turn: 't1', agent: 'codex' } }
  const routes = { [item.key]: route }
  expect(boardKey(drawn(confirm), 'y', items, s, routes).action).toEqual({ type: 'send', key: item.key, text: s.yesAnswer, route })
  const sending = boardScreen(view, [], drawn(confirm), s, { width: 80, isColor: false, routes })
  expect(sending).toContain(s.boardAnswerSends('y/n', 'Codex'))
  expect(sending).toContain(s.boardKeyConfirmSend)
  expect(sending).not.toContain(s.boardAnswerCopiesTo('y/n', 'Codex'))
  // A line that changed since it was drawn is not answered.
  expect(boardKey({ ...drawn(confirm), seen: { [item.key]: 'old' } }, 'y', items, s, routes).action).toBeNull()
  // The page's own board says which questions it sends.
  expect(routesOf({ asks: [{ key: item.key, send: 'connected', agent: 'codex', session: 's', text: 'Publish them to staging, OK?', fp: route.fp, delivery: { id: 'c1', turn: 't1', agent: 'codex' } }, { key: 'ask:x', send: 'none' }, { key: 'ask:y', send: 'send', agent: 'grok', session: 'g', text: 'Q?', fp: 'f' }] })).toEqual({ [item.key]: route, 'ask:y': { mode: 'send', agent: 'grok', session: 'g', asked: 'Q?', fp: 'f' } })
  expect(routesOf(null)).toEqual({})
})

test('the terminal board lists what waits on you, then what is working, then the rest by project, with agent names and ages in one column', () => {
  const s = STRINGS.en
  const view = viewOf(BOARD)
  const out = boardScreen(view, [], pinned({ ...emptyBoardState, selected: 1 }, boardItems(view, [])), s, { width: 80, isColor: false })
  const order = [s.sectionWaiting, s.sectionActive, 'notes'].map(word => out.indexOf(word))
  expect(order.every((one, index) => one >= 0 && (index === 0 || one > order[index - 1]!))).toBe(true)
  const codex = out.split('\n').find(line => line.includes('Publish them to staging'))!
  const claude = out.split('\n').find(line => line.includes('Add a synthetic health check'))!
  const asked = view.waiting[0]!.when
  expect(codex.trimEnd().endsWith(asked === s.questionAgeUnknown ? 'Codex' : `Codex · ${asked}`)).toBe(true)
  expect(claude.trimEnd().endsWith('Claude Code · 50 min ago')).toBe(true)
  // The ages end in one column.
  expect(displayColumns(codex.trimEnd())).toBe(displayColumns(claude.trimEnd()))
  // The working row names its project and the step it is on.
  expect(out).toContain('sample-api · 1/3 · ▸ Write the handler')
  expect(out).not.toContain('· codex')
})

test('the terminal board says a live session cannot be archived only after a is pressed', () => {
  const s = STRINGS.en
  const view = viewOf(BOARD)
  const items = boardItems(view, [])
  for (const index of [0, 1]) {
    const drawn = pinned({ ...emptyBoardState, selected: index }, items)
    expect(boardScreen(view, [], drawn, s, { width: 80, isColor: false })).not.toContain(s.archiveLive)
    const pressed = boardKey(drawn, 'a', items, s)
    expect(pressed.action).toBeNull()
    expect(pressed.state.note).toBe(s.archiveLive)
    expect(boardScreen(view, [], pressed.state, s, { width: 80, isColor: false })).toContain(s.archiveLive)
  }
})

test('the terminal board shows the whole way back to a session with the command c copies', () => {
  const s = STRINGS.en
  const file = `## data
<!-- auto session=a1b2c3d4 state=waiting updated=${at(5)} resume=a1b2c3d4-1111-2222-3333 dir=%2Fhome%2Fsomeone%2Fprojects%2Fdata-pipeline-with-a-long-name%2Fservices%2Fevents -->
### Backfill the events
- [?] Keep the old table, OK?
<!-- /auto session=a1b2c3d4 -->
`
  const view = viewOf(file)
  const out = boardScreen(view, [], pinned(emptyBoardState, boardItems(view, [])), s, { width: 80, isColor: false })
  const command = `cd '/home/someone/projects/data-pipeline-with-a-long-name/services/events' && claude --resume a1b2c3d4-1111-2222-3333`
  const words = out.split('\n').map(line => line.trim()).join(' ')
  // The folder and id stay off the screen; c copies the whole command.
  expect(words).toContain(s.boardAnswerInCopy('Claude Code', 'claude --resume …'))
  expect(out).not.toContain('a1b2c3d4-1111-2222-3333')
  expect(out).not.toContain('/home/someone')
  expect(boardKey(pinned(emptyBoardState, boardItems(view, [])), 'c', boardItems(view, []), s).action).toEqual({ type: 'copy', text: command })
  for (const line of out.split('\n')) expect(displayColumns(line)).toBeLessThanOrEqual(80)
})

test('the terminal board lists what finished with t to archive it now, and an empty board names its agents', () => {
  const s = STRINGS.en
  const done = `## docs-site
<!-- auto session=c0ffee12 agent=codex state=done updated=${at(3)} -->
### Fix the synthetic typo
- [x] Fix it
<!-- /auto session=c0ffee12 -->
`
  const view = viewOf(done)
  const out = boardScreen(view, [], emptyBoardState, s, { width: 80, isColor: false })
  expect(out).toContain(`✓ ${s.sectionRecent}  ${s.boardKeyArchiveDone}`)
  expect(out).toContain('docs-site › Fix the synthetic typo')
  expect(boardKey(emptyBoardState, 't', boardItems(view, []), s).action).toEqual({ type: 'tidy' })
  const empty = viewOf('# Progress\n')
  const agents = boardAgents(['codex-turn-1700000000000-x.json', 'claude-end-1700000000000-y.json', 'notes.txt'], empty, [])
  expect(agents).toEqual(['codex', 'claude'])
  const screen = boardScreen(empty, [], emptyBoardState, s, { width: 80, isColor: false, agents })
  expect(screen).toContain(s.empty)
  expect(screen).toContain(s.boardAgentsHere('Codex, Claude Code'))
  expect(boardScreen(empty, [], emptyBoardState, s, { width: 80, isColor: false })).toContain(s.boardNoAgents.split(':')[0]!)
})

test('a question hidden with h on the terminal board leaves its task title shown once', () => {
  const s = STRINGS.en
  const view = viewOf(BOARD)
  const items = boardItems(view, [])
  const pressed = boardKey(pinned(emptyBoardState, items), 'h', items, s)
  expect(pressed.action?.type).toBe('hide')
  // The question is gone from the next draw; its task is still a row.
  const hidden = view.waiting[0]!.hideKey
  const after = { ...view, waiting: [], hidden: [{ key: hidden, text: 'Publish them to staging, OK?', project: 'docs-site', task: 'Ship the synthetic docs' }] } as unknown as typeof view
  const state = pinned({ ...pressed.state, key: null, note: s.boardHidden('Publish them to staging, OK?'), tone: 'done', result: { ...pressed.state.result!, revision: null } }, boardItems(after, []))
  const out = boardScreen(after, [], state, s, { width: 80, isColor: false })
  expect(out.split('Ship the synthetic docs').length - 1).toBe(1)
  expect(out).toContain('Hidden: “Publish them to staging, OK?”')
})

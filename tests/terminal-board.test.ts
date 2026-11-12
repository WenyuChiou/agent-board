import { expect, test } from 'claude-code/testing'
import { confirmTask, takeTask, upsertAutoBlock } from '../hooks/blocks'
import { boardAgents, boardItems, boardKey, boardLayout, boardScreen, boardText, chatText, displayColumns, emptyBoardState, fingerprint, frame, nearest256, peekInbox, pinned, routesOf, terminalLook } from '../hooks/board'
import type { AnswerRoute } from '../hooks/board'
import { codexEvent, codexLifecycleStep, isLifecycleStep, LIFECYCLE_STEPS, localAgentLifecycleStep, putCodexBlock } from '../hooks/codex'
import { applyDigest, noteChatReply, settleChatReply } from '../hooks/digest'
import { answerAgentPrompt } from '../hooks/inbox'
import { applyTaskCreate, emptyMirror } from '../hooks/mirror'
import { DARK, LIGHT } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { serveModel } from '../hooks/serve'
import { emptyQuestions, observeQuestions, resolveQuestion } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { STRINGS } from '../hooks/strings'
import { buildView, rowNeedsYou } from '../hooks/view'

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

test('a blocked agent needs you on both the terminal board and the page', () => {
  const file = `## sample-api
<!-- auto session=ab770001 agent=antigravity state=working updated=${at(5)} -->
### Ship the synthetic endpoint
- [!] Supply the synthetic credential — Waiting for a test credential
<!-- /auto session=ab770001 -->
`
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    for (const state of ['working', 'waiting']) {
      const view = viewOf(file.replace('state=working', `state=${state}`), lang)
      const model = serveModel(view, [], s, new Set(), false, undefined, false, { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } })
      expect(model.view!.needs.stuck).toBe(1)
      expect(model.view!.needs.cards[0]!.agent).toBe('antigravity')
      expect(model.view!.working).toEqual([])
      expect(model.groups[0]!.rows[0]!.stuck!.reason).toBe('Waiting for a test credential')
      for (const out of [boardText(view, [], s), boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false })]) {
        expect(out).toContain(s.pgNeeds)
        expect(out).not.toContain(s.agentWorking('Antigravity'))
        expect(out).not.toContain(s.nothingForYou)
      }
    }
  }
})

test('a question on the terminal board is worded once, and a row that needs you does not count as in progress', () => {
  const s = STRINGS.en
  const question = 'Ship to staging, OK?'
  const view = viewOf(`## sample-api
<!-- auto session=ab770005 agent=antigravity state=working updated=${at(5)} -->
### Check the synthetic release
- [?] ${question}
<!-- /auto session=ab770005 -->
`)
  const screen = boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false })
  expect(screen.split(question).length - 1).toBe(1)
  expect(screen).not.toContain(`● ${s.pgNeeds}`)
  expect(screen).toContain(`▸ 0 ${s.countActive}`)
  const text = boardText(view, [], s)
  expect(text).not.toContain(s.pgNeedsWhy(question))
  expect(text).toContain(`▸ 0 ${s.countActive}`)
  expect(text).not.toContain(s.groupWorking(1))
})

test('a blocked row is counted once when it is both due and in its group, and not at all on a shelf', () => {
  const s = STRINGS.en
  const view = viewOf(`## sample-api
<!-- auto session=ab770006 agent=antigravity state=working updated=${at(5)} -->
### Need a synthetic key
- [!] Supply the synthetic credential
<!-- /auto session=ab770006 -->
`)
  const row = view.groups[0]!.rows[0]!
  const count = (board: typeof view) => boardText(board, [], s).split('\n')[0]!
  expect(count(view)).toContain(`● 1 ${s.countWaiting}`)
  expect(count({ ...view, due: [row] })).toContain(`● 1 ${s.countWaiting}`)
  expect(count({ ...view, idle: [row] })).toContain(`● 0 ${s.countWaiting}`)
  expect(count({ ...view, stopped: [row] })).toContain(`● 0 ${s.countWaiting}`)
})

test('a row whose question merged into another card, or was covered by an answer, is in progress on the terminal board as on the page', () => {
  const s = STRINGS.en
  const page = (board: ReturnType<typeof viewOf>) => serveModel(board, [], s, new Set(), false, undefined, false, { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } }).view!
  const block = (id: string, title: string): string => `<!-- auto session=${id} agent=antigravity state=working updated=${at(5)} dir=/synthetic/p -->
### ${title}
- [?] Ship it, OK?
<!-- /auto session=${id} -->
`
  const first = block('ab770007', 'First copy')
  const both = parseProgress(`## sample-api
${first}${block('ab770008', 'Second copy')}`)
  const seen = observeQuestions(emptyQuestions(), parseProgress(`## sample-api
${first}`), null, [], NOW - 2000, true, 's1').ledger
  const ledger = observeQuestions(seen, both, null, [], NOW - 1000, true, 's2').ledger
  const later = ledger.records.find(record => record.scope.includes('ab770008'))!
  for (const [view, waiting, active] of [
    [buildView(both, [], null, NOW, 0, {}, s, [], {}, ledger), 1, 1],
    [buildView(both, [], null, NOW, 0, {}, s, [later.id], {}, resolveQuestion(ledger, later.id, NOW)), 0, 2],
  ] as const) {
    const onPage = page(view)
    expect(onPage.needs.n).toBe(waiting)
    expect(onPage.working.length).toBe(active)
    for (const out of [boardText(view, [], s, { width: 100, isColor: false }), boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false })]) {
      expect(out).toContain(`● ${waiting} ${s.countWaiting}`)
      expect(out).toContain(`▸ ${active} ${s.countActive}`)
      expect(out).not.toContain(`${s.pgNeeds}: `)
    }
    expect(view.groups[0]!.summary).toBe(`${s.groupCount(2)} · ${s.groupWorking(active)}`)
  }
})

test('the terminal board draws each heading once when a row that needs you sits among rows at work', () => {
  const s = STRINGS.en
  const row = (id: string, state: string, title: string, step: string): string => `<!-- auto session=${id} agent=antigravity state=${state} updated=${at(5)} -->
### ${title}
- ${step}
<!-- /auto session=${id} -->
`
  const drawn = (rows: string): string => {
    const view = viewOf(`## sample-api
${rows}`)
    return boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false })
  }
  const heads = (out: string, word: string): number => out.split('\n').filter(line => line.trim() === word).length
  const stuck = drawn(`${row('ab770009', 'working', 'At work one', '[~] Write')}${row('ab77000a', 'working', 'Blocked', '[!] Supply the synthetic key')}${row('ab77000b', 'working', 'At work two', '[~] Test')}`)
  expect(heads(stuck, `● ${s.pgNeeds}`)).toBe(1)
  expect(heads(stuck, `▸ ${s.sectionActive}`)).toBe(1)
  expect(stuck.indexOf('Blocked')).toBeLessThan(stuck.indexOf('At work one'))
  const asking = drawn(`${row('ab77000c', 'working', 'At work one', '[~] Write')}${row('ab77000d', 'working', 'Asking', '[?] Ship it, OK?')}${row('ab77000e', 'working', 'At work two', '[~] Test')}`)
  expect(heads(asking, `▸ ${s.sectionActive}`)).toBe(1)
  const waiting = drawn(`${row('ab77000f', 'waiting', 'Paused one', '[ ] Write')}${row('ab770010', 'waiting', 'Blocked', '[!] Supply the synthetic key')}${row('ab770011', 'waiting', 'Paused two', '[ ] Test')}`)
  expect(heads(waiting, `● ${s.pgNeeds}`)).toBe(1)
  expect(heads(waiting, 'sample-api')).toBe(1)
})

test('terminal attention follows live questions and leaves stopped and hand-kept blockers on their shelves', () => {
  const s = STRINGS.en
  const file = `## sample-api
<!-- auto session=ab770002 agent=antigravity state=working updated=${at(5)} -->
### Check the synthetic release
- [?] Ship to staging, OK?
<!-- /auto session=ab770002 -->
`
  const view = viewOf(file)
  const model = serveModel(view, [], s, new Set(), false, undefined, false, { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } })
  expect(model.view!.needs.questions).toBe(1)
  expect(model.view!.working).toEqual([])
  const row = view.active[0]!
  expect(rowNeedsYou(row)!.kind).toBe('question')
  expect(rowNeedsYou(row, true)).toBeNull()
  for (const out of [boardText(view, [], s), boardScreen(view, [], emptyBoardState, s, { width: 100, isColor: false })]) {
    expect(out).toContain(s.pgNeeds)
    expect(out).not.toContain(s.agentWorking('Antigravity'))
  }
  const blocked = file.replace('- [?] Ship to staging, OK?', '- [!] Supply the synthetic credential')
  for (const source of [blocked.replace('state=working', 'state=ended'), blocked.replace(/<!--[^\n]*-->/g, '')]) {
    const shelf = viewOf(source)
    const page = serveModel(shelf, [], s, new Set(), false, undefined, false, { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } })
    expect(page.view!.needs.n).toBe(0)
    for (const out of [boardText(shelf, [], s, { width: 100, isColor: false, isIdleOpen: true }), boardScreen(shelf, [], { ...emptyBoardState, isIdleOpen: true }, s, { width: 100, isColor: false })]) {
      expect(out).not.toContain(s.pgNeeds)
    }
  }
})

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

// #612, with the made-up projects of the page's tests: an agent that asks and one that stopped 2
// minutes ago are both on the board, which never says that no agent did anything.
const ASKING_AND_STOPPED = `# Progress

## demo-garden
<!-- auto session=61200001 agent=codex state=waiting updated=${at(1)} -->
### Choose the seed mix
- [x] Compare
- [?] Clover or rye?
<!-- /auto session=61200001 -->

## demo-orchard
<!-- auto session=61200002 agent=gemini state=ended updated=${at(2)} -->
### Prune the synthetic rows
- [x] Prune
- [ ] Water
<!-- /auto session=61200002 -->
`

test('the terminal board shows an agent that asks and one that just stopped, and never says no agent did anything', () => {
  const s = STRINGS.en
  const view = viewOf(ASKING_AND_STOPPED)
  for (const out of [boardScreen(view, [], pinned(emptyBoardState, boardItems(view, [])), s, { width: 100, isColor: false }), boardText(view, [], s, { width: 100, isColor: false })]) {
    expect(out).toContain('Clover or rye?')
    expect(out).toContain(s.stoppedCount(1))
    expect(out).not.toContain(s.pgNoWorking)
  }
})

const lifecycleBoard = (state: string, step: string): string => `# Progress

## demo-garden
<!-- auto session=61200003 agent=codex state=${state} updated=${at(2)} -->
### Demo-Garden
- [ ] ${step}
<!-- /auto session=61200003 -->
`

test('a working Codex session with no block of its own names its project once on the terminal board and does not say it waits', () => {
  const s = STRINGS.en
  // Today's words, and those an earlier release wrote, which old blocks still hold.
  for (const step of [s.codexLifecycle, s.codexLifecycleWorking, s.localAgentLifecycle, s.localAgentLifecycleWorking, 'Local session activity; Codex explicitly reports task steps', STRINGS['zh-TW'].codexLifecycle, STRINGS['zh-TW'].codexLifecycleWorking]) {
    const view = viewOf(lifecycleBoard('working', step))
    const screen = boardScreen(view, [], pinned(emptyBoardState, boardItems(view, [])), s, { width: 100, isColor: false })
    expect(screen.toLowerCase().split('demo-garden').length - 1).toBe(1)
    // The printed board groups rows under their project's heading; the row itself does not repeat it.
    for (const out of [screen, boardText(view, [], s, { width: 100, isColor: false })]) expect(out).not.toContain(step)
  }
  // Once it waits, the hook's words are true and the board says them.
  const waiting = viewOf(lifecycleBoard('waiting', s.codexLifecycle))
  expect(boardScreen(waiting, [], pinned(emptyBoardState, boardItems(waiting, [])), s, { width: 100, isColor: false })).toContain(s.codexLifecycle)
})

test('every placeholder step a hook writes, in every language and as earlier releases wrote it, is known as one', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    expect(isLifecycleStep(STRINGS[lang].codexLifecycle)).toBe(true)
    expect(isLifecycleStep(STRINGS[lang].codexLifecycleWorking)).toBe(true)
    expect(isLifecycleStep(STRINGS[lang].localAgentLifecycle)).toBe(true)
    expect(isLifecycleStep(STRINGS[lang].localAgentLifecycleWorking)).toBe(true)
  }
  for (const earlier of ['Native session activity; the current agent explicitly reports task steps', '本地 session 活动状态；任务步骤由 Codex 明确报告']) expect(isLifecycleStep(earlier)).toBe(true)
  expect(isLifecycleStep('Water the synthetic rows')).toBe(false)
  expect([...LIFECYCLE_STEPS].length).toBeGreaterThanOrEqual(12)
})

test('an Antigravity session stopped on a limit leaves the working list', () => {
  const s = STRINGS.en
  const file = `## scratch
<!-- auto session=ab770010 agent=antigravity state=working updated=${at(58)} -->
### Local antigravity task
- [ ] ${s.localAgentLifecycle}
<!-- /auto session=ab770010 -->
`
  const view = viewOf(file)
  const model = serveModel(view, [], s, new Set(), false, undefined, false, { now: NOW, repoOf: () => null, unreadable: [], versions: { board: 'synthetic', package: null } })
  expect(model.view!.working).toEqual([])
  expect(view.groups.length).toBe(0)
  expect(view.stopped.length).toBe(1)
  expect(view.stopped[0]!.title).toBe('Local antigravity task')
  const text = boardText(view, [], s, { width: 100, isColor: false })
  expect(text).not.toContain(s.agentWorking('Antigravity'))
  expect(text).not.toContain(s.groupWorking(1))
})

test('a silence-classified row does not offer confirmation or archive that the write guard refuses', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    const file = `## scratch\n<!-- auto session=ab770010 agent=antigravity state=working updated=${at(58)} -->\n### Local antigravity task\n- [ ] ${s.localAgentLifecycle}\n<!-- /auto session=ab770010 -->\n`
    const view = viewOf(file, lang)
    expect(view.stopped.length).toBe(1)
    const stoppedRow = view.stopped[0]!
    expect(stoppedRow.confirm).toBeNull()
    expect(stoppedRow.archive).toBeNull()
    // The write guard refuses confirmation and archive for an active session under STALE_MS
    const forgedConfirm = { project: 'scratch', title: 'Local antigravity task', line: 2, session: 'ab770010', expected: '' }
    expect(confirmTask(file, forgedConfirm, NOW, s)).toBeNull()
    const forgedArchive = { project: 'scratch', title: 'Local antigravity task', line: 2, session: 'ab770010' }
    expect(takeTask(file, forgedArchive, NOW, s)).toBeNull()
  }
})

test('a silence-classified row past the stale time offers confirmation and archive that the write guard accepts (#898)', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    const file = `## scratch\n<!-- auto session=ab770011 agent=antigravity state=working updated=${at(13 * 60)} -->\n### Local antigravity task\n- [ ] ${s.localAgentLifecycle}\n<!-- /auto session=ab770011 -->\n`
    const view = viewOf(file, lang)
    expect(view.stopped.length).toBe(1)
    const stoppedRow = view.stopped[0]!
    expect(stoppedRow.confirm).not.toBeNull()
    expect(stoppedRow.archive).not.toBeNull()
    // Both write guards accept a row past STALE_MS, so the row's offers land
    expect(confirmTask(file, stoppedRow.confirm!, NOW, s)).not.toBeNull()
    expect(takeTask(file, stoppedRow.archive!, NOW, s)).not.toBeNull()
  }
})

test('a working row with a doing step remains counted after thirty minutes', () => {
  for (const agent of ['antigravity', 'codex'] as const) {
    for (const age of [5, 30, 31, 58]) {
      const s = STRINGS.en
      const file = `## demo\n<!-- auto session=11223344 agent=${agent} state=working updated=${at(age)} -->\n### Active task\n- [~] Compute the synthetic result\n<!-- /auto session=11223344 -->\n`
      const view = viewOf(file, 'en')
      expect(view.stopped.length).toBe(0)
      expect(view.groups.length).toBe(1)
      expect(view.groups[0]!.summary).toContain(s.groupWorking(1))
      const text = boardText(view, [], s, { width: 100, isColor: false })
      expect(text).toContain(s.agentWorking(agent === 'codex' ? 'Codex' : 'Antigravity'))
    }
  }
})

test('a working Codex or local agent placeholder step matches its state in all languages (#1142)', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    expect(codexLifecycleStep('working', s)).toBe(`- [ ] ${s.codexLifecycleWorking}`)
    expect(codexLifecycleStep('waiting', s)).toBe(`- [ ] ${s.codexLifecycle}`)
    expect(localAgentLifecycleStep('working', s)).toBe(`- [ ] ${s.localAgentLifecycleWorking}`)
    expect(localAgentLifecycleStep('waiting', s)).toBe(`- [ ] ${s.localAgentLifecycle}`)

    // Codex hook events transition placeholder step between waiting and working
    const start = codexEvent(null, { session_id: 's-1142', hook_event_name: 'SessionStart' }, at(5), s)
    expect(start.state).toBe('waiting')
    expect(start.steps).toEqual([`- [ ] ${s.codexLifecycle}`])

    const prompt = codexEvent(start, { session_id: 's-1142', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, at(4), s)
    expect(prompt.state).toBe('working')
    expect(prompt.steps).toEqual([`- [ ] ${s.codexLifecycleWorking}`])

    const stop = codexEvent(prompt, { session_id: 's-1142', hook_event_name: 'Stop', turn_id: 'turn-1' }, at(3), s)
    expect(stop.state).toBe('waiting')
    expect(stop.steps).toEqual([`- [ ] ${s.codexLifecycle}`])

    // Prompt submitted with closing question
    const askStop = codexEvent(prompt, { session_id: 's-1142', hook_event_name: 'Stop', turn_id: 'turn-1', question: 'Should we proceed?' }, at(2), s)
    expect(askStop.state).toBe('waiting')
    expect(askStop.steps).toEqual([`- [ ] ${s.codexLifecycle}`, '- [?] Should we proceed?'])

    const answered = codexEvent(askStop, { session_id: 's-1142', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' }, at(1), s)
    expect(answered.state).toBe('working')
    expect(answered.steps).toEqual([`- [ ] ${s.codexLifecycleWorking}`, '- [?] Should we proceed?'])
    expect(answered.replied).toBe(at(1))
  }
})

test('a reply typed in chat changes every board surface while its durable question stays open', () => {
  const OWNER = '0'.repeat(64)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const s = STRINGS[lang]
    const ledgerOf = (file: string, previous = emptyQuestions()) => observeQuestions(previous, parseProgress(file), null, [], NOW, true).ledger
    const unresolved = (ledger: QuestionLedger) => ledger.records.filter(record => record.isUnresolved).map(record => record.id)
    const viewOfFile = (file: string, ledger: QuestionLedger) => buildView(parseProgress(file), [], null, NOW, 0, {}, s, [], {}, ledger)
    const checkWaitingForAgent = (view: ReturnType<typeof buildView>) => {
      expect(view.overview.waiting).toBe(0)
      expect(view.waiting).toEqual([])
      expect(view.groups[0]?.rows[0]?.status).toBe(s.answeredWaiting)
      const page = serveModel(view, [], s)
      expect(page.counts.waiting).toBe(0)
      expect(page.groups[0]?.rows[0]?.status).toBe(s.answeredWaiting)
      expect(boardScreen(view, [], emptyBoardState, s, { width: 120, isColor: false })).toContain(s.answeredWaiting)
      expect(chatText(view, [], [], s, '/synthetic/home')).toContain(s.answeredWaiting)
    }

    // 1. Codex: Prompt submitted in agent chat
    const start = codexEvent(null, { session_id: 's-401', hook_event_name: 'SessionStart' }, at(10), s)
    const prompt1 = codexEvent(start, { session_id: 's-401', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }, at(9), s)
    const askStop = codexEvent(prompt1, { session_id: 's-401', hook_event_name: 'Stop', turn_id: 'turn-1', question: 'Deploy to production?' }, at(5), s)
    expect(askStop.state).toBe('waiting')

    const fileWaiting = `# Progress\n\n## backend\n${putCodexBlock('', askStop, OWNER)}\n`
    const original = ledgerOf(fileWaiting)
    expect(unresolved(original)).toHaveLength(1)
    const viewWaiting = viewOfFile(fileWaiting, original)
    expect(viewWaiting.overview.waiting).toBe(1)
    expect(viewWaiting.waiting.length).toBe(1)
    expect(viewWaiting.waiting[0]?.text).toBe('Deploy to production?')

    const typed = { session_id: 's-401', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' }
    for (const stamp of [at(6), at(5), 'invalid-time', at(-1)])
      expect(codexEvent(askStop, typed, at(2), s, stamp)).toEqual(askStop)
    expect(codexEvent(askStop, { ...typed, prompt_submitted: false }, at(2), s).replied).toBeUndefined()
    expect(() => codexEvent(askStop, { ...typed, session_id: 'foreign-owner' }, at(2), s)).toThrow('SESSION_CONFLICT')

    // Recovery can retain a whole-second display value while the host's source
    // clock orders the question, reply and report inside that second.
    const second = Date.parse(at(5))
    const timing = { lastAppliedAt: second + 300, observedAt: second + 900 }
    expect(codexEvent(askStop, typed, at(5), s, second + 300, timing)).toEqual(askStop)
    const sameSecond = codexEvent(askStop, typed, at(5), s, second + 500, timing)
    expect(Date.parse(sameSecond.replied!)).toBe(second + 500)
    const report = { session_id: 's-401', hook_event_name: 'Stop', turn_id: 'turn-2', has_response: true }
    expect(codexEvent(sameSecond, report, at(5), s, second + 500, timing)).toEqual(sameSecond)
    const reported = codexEvent(sameSecond, report, at(5), s, second + 700, timing)
    expect(reported.replied).toBeUndefined()
    expect(reported.steps[reported.asked!]).toBe('- [x] Deploy to production?')

    // Newer prompt submitted in Codex session chat: question leaves Needs you, row says answeredWaiting
    const answered = codexEvent(askStop, typed, at(2), s)
    expect(answered.replied).toBe(at(2))

    const fileReplied = `# Progress\n\n## backend\n${putCodexBlock('', answered, OWNER)}\n`
    const pending = ledgerOf(fileReplied, original)
    expect(unresolved(pending)).toEqual(unresolved(original))
    checkWaitingForAgent(viewOfFile(fileReplied, pending))
    expect(unresolved(resolveQuestion(pending, unresolved(original)[0]!, NOW))).toEqual([])

    // Agent's next report without question settles it
    const nextStop = codexEvent(answered, { session_id: 's-401', hook_event_name: 'Stop', turn_id: 'turn-2', has_response: true }, at(1), s)
    expect(nextStop.replied).toBeUndefined()
    const fileSettled = `# Progress\n\n## backend\n${putCodexBlock('', nextStop, OWNER)}\n`
    const settled = ledgerOf(fileSettled, pending)
    expect(unresolved(settled)).toEqual([])
    const viewSettled = viewOfFile(fileSettled, settled)
    expect(viewSettled.overview.waiting).toBe(0)
    expect(viewSettled.waiting).toEqual([])

    // Agent's next report with a new question asks again
    const askAgain = codexEvent(answered, { session_id: 's-401', hook_event_name: 'Stop', turn_id: 'turn-2', question: 'Deploy to production?' }, at(1), s)
    const fileAskAgain = `# Progress\n\n## backend\n${putCodexBlock('', askAgain, OWNER)}\n`
    const askedAgain = ledgerOf(fileAskAgain, pending)
    expect(unresolved(askedAgain)).toHaveLength(1)
    expect(unresolved(askedAgain)[0]).not.toBe(unresolved(original)[0])
    const viewAskAgain = viewOfFile(fileAskAgain, askedAgain)
    expect(viewAskAgain.overview.waiting).toBe(1)
    expect(viewAskAgain.waiting.length).toBe(1)
    expect(viewAskAgain.waiting[0]?.text).toBe('Deploy to production?')

    // 2. Inbox: An inbox agent prompt event answers the waiting question
    const inboxTime = NOW - 100_000
    const geminiMirror = {
      ...applyDigest(emptyMirror('s-inbox', 'frontend', inboxTime, '/workspace/frontend', 'gemini'),
        { title: 'Build frontend', context: '', done: '', next: '', ask: 'Ready to build, OK?', why: '' }, inboxTime, s),
      resume: 's-inbox',
      state: 'waiting' as const,
      turnOrder: inboxTime * 2,
    }
    const fileGeminiWaiting = upsertAutoBlock('# Progress\n', geminiMirror, s)
    const inboxOriginal = ledgerOf(fileGeminiWaiting)
    expect(unresolved(inboxOriginal)).toHaveLength(1)
    const viewGeminiWaiting = viewOfFile(fileGeminiWaiting, inboxOriginal)
    expect(viewGeminiWaiting.overview.waiting).toBe(1)
    expect(viewGeminiWaiting.waiting.length).toBe(1)

    // Older prompt or prompt with no time returns null
    const olderPromptTurn = { agent: 'gemini', event: 'prompt' as const, session: 's-inbox', id: 's-inbox', cwd: '/workspace/frontend', project: 'frontend', prompt: '', answer: '', transcript: '', at: NOW - 120_000 }
    expect(answerAgentPrompt(geminiMirror, olderPromptTurn, NOW)).toBeNull()

    // Newer prompt answers agent: sets replied, leaves Needs you, row says answeredWaiting
    const promptTurn = { agent: 'gemini', event: 'prompt' as const, session: 's-inbox', id: 's-inbox', cwd: '/workspace/frontend', project: 'frontend', prompt: '', answer: '', transcript: '', at: NOW - 50_000 }
    const answeredMirror = answerAgentPrompt(geminiMirror, promptTurn, NOW)!
    expect(answeredMirror).not.toBeNull()
    expect(answeredMirror.updated).toBe(NOW - 50_000)
    expect(answeredMirror.replied).toBe(answeredMirror.updated)

    const fileGeminiReplied = upsertAutoBlock(fileGeminiWaiting, answeredMirror, s)
    const inboxPending = ledgerOf(fileGeminiReplied, inboxOriginal)
    expect(unresolved(inboxPending)).toEqual(unresolved(inboxOriginal))
    checkWaitingForAgent(viewOfFile(fileGeminiReplied, inboxPending))

    // 3. Claude Mirror: Typing in chat sets replied and leaves Needs you
    const claudeMirror = applyTaskCreate(emptyMirror('claude-sess-1', 'core', inboxTime, '/workspace/core'),
      { subject: 'Verify fix?', metadata: { waiting: 'you', why: 'Needs your approval' } }, '1', inboxTime)
    const ownOriginal = observeQuestions(emptyQuestions(), [], claudeMirror, [], NOW, true).ledger
    expect(unresolved(ownOriginal)).toHaveLength(1)
    const viewClaudeWaiting = buildView([], [], claudeMirror, NOW, 0, {}, s, [], {}, ownOriginal)
    expect(viewClaudeWaiting.overview.waiting).toBe(1)
    expect(viewClaudeWaiting.waiting.length).toBe(1)

    // Later prompt submitted in Claude chat
    const claudeReplied = noteChatReply(claudeMirror, NOW - 50_000)
    const ownPending = observeQuestions(ownOriginal, [], claudeReplied, [], NOW, true).ledger
    expect(unresolved(ownPending)).toEqual(unresolved(ownOriginal))
    const viewClaudeReplied = buildView([], [], claudeReplied, NOW, 0, {}, s, [], {}, ownPending)
    expect(viewClaudeReplied.overview.waiting).toBe(0)
    expect(viewClaudeReplied.waiting).toEqual([])
    expect(viewClaudeReplied.current?.status).toBe(s.answeredWaiting)
    const claudeFile = upsertAutoBlock('# Progress\n', claudeReplied, s)
    checkWaitingForAgent(viewOfFile(claudeFile, ledgerOf(claudeFile)))

    // Next Claude report with new question asks again
    const claudeAskAgain = applyTaskCreate(settleChatReply(claudeReplied),
      { subject: 'Merge PR?', metadata: { waiting: 'you', why: 'Needs your confirmation' } }, '2', NOW - 10_000)
    const ownNext = observeQuestions(ownPending, [], claudeAskAgain, [], NOW, true).ledger
    expect(unresolved(ownNext)).toHaveLength(1)
    expect(unresolved(ownNext)[0]).not.toBe(unresolved(ownOriginal)[0])
    const viewClaudeAskAgain = buildView([], [], claudeAskAgain, NOW, 0, {}, s, [], {}, ownNext)
    expect(viewClaudeAskAgain.overview.waiting).toBe(1)
    expect(viewClaudeAskAgain.waiting.length).toBe(1)
  }
})

test('the terminal board answers a mailbox card the way the page does, and copies a card the page only copies (#1351)', () => {
  const delivery = { id: 'mailbox_0123456789abcdef01234567', turn: 'session', agent: 'deepseek' }
  const routes = routesOf({ asks: [
    { key: 'ask:mailbox', send: 'mailbox', agent: 'deepseek', session: 's', text: 'Blue or green?', fp: 'f', delivery },
    { key: 'ask:copy', send: 'none', agent: 'deepseek', session: 's2', text: 'Blue or green?', fp: 'g' },
    { key: 'ask:nodelivery', send: 'mailbox', agent: 'deepseek', session: 's3', text: 'Q?', fp: 'h' },
  ] })
  expect(routes).toEqual({ 'ask:mailbox': { mode: 'connected', agent: 'deepseek', session: 's', asked: 'Blue or green?', fp: 'f', delivery } })
})

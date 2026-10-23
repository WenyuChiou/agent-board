import { expect, test } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { addManualTask, CUT_SETTLE_MS, cutBlockLines, cutOffBlocks, cutOffSpans, mergeBlock, removeAutoBlock, scanBlocks, takeArchivable, takeTask, upsertAutoBlock } from '../hooks/blocks'
import { boardScreen, boardText, chatText } from '../hooks/board'
import type { PendingTurn } from '../hooks/board'
import { dashboardHtml } from '../hooks/dashboard'
import { localDay } from '../hooks/journal'
import { parseProgress, progressTail } from '../hooks/parse'
import { putCodexBlock } from '../hooks/codex'
import { cutOffScopes, emptyQuestions, isQuestionSnapshot, ledgerLeftovers, observeQuestions, resolvedQuestionsToRetire, resolveQuestion } from '../hooks/questions'
import { sha256 } from '../hooks/sha256'
import { STRINGS } from '../hooks/strings'
import { buildView, viewCache } from '../hooks/view'

// A board with a block cut off in the middle (no end marker, more of the file after it), as a
// write that never finished leaves it. All data is made up.
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const EN = STRINGS.en
const CUT = '<!-- auto session=55fb44cb agent=codex state=waiting updated=2026-10-20T01:17:08.128Z source=turns -->'
const OTHER = [
  '<!-- auto session=1d0ef21d agent=codex state=waiting updated=2026-10-20T04:12:58.831Z -->',
  '### Fix the working text',
  '> waiting on your reply',
  '- [?] Ship it, OK?',
  '<!-- /auto session=1d0ef21d -->',
]
const DONE = [
  '<!-- auto session=9a9a9a9a agent=codex state=done updated=2026-10-10T04:12:58.831Z -->',
  '### A finished plan',
  '- [x] Did it',
  '<!-- /auto session=9a9a9a9a -->',
]
const HAND = ['### Hand-kept task', '- [ ] Keep me']
const BEFORE = ['# Progress', '', '## demo-152', '', CUT, '### Add a shelf', '> waiting on your repl']
const AFTER = ['', '## demo-154', '', ...OTHER, '', ...DONE, '', ...HAND, '']
const BOARD = [...BEFORE, ...AFTER].join('\n')
// What follows the cut-off block, from the blank line after it to the end of the file.
const FOLLOWING = AFTER.join('\n')
const OWNER = 'aaaaaaaa'.repeat(8)
const CUT_MARKER = `<!-- auto session=aaaaaaaa agent=codex source=codex-local owner=${OWNER} state=waiting updated=2026-10-20T01:17:08.128Z -->`
const P0_TAIL = [...HAND, ...AFTER].join('\n')
const P0 = ['# Progress', '', '## demo-152', '', CUT_MARKER, P0_TAIL].join('\n')

const mirror = (sessionId: string, project: string): ProgressMirror => ({
  sessionId, agent: 'codex', project, cwd: '', branch: '', pr: null, title: 'Rewritten plan', context: '', isTitleFinal: true, firstPrompt: '', state: 'waiting', updated: NOW, source: 'turns',
  tasks: [{ id: '1', subject: 'Next step', status: 'pending', activeForm: '', waiting: null, why: null, ask: null, options: [], command: null, link: null, blocked: null, blockedBy: [] }],
} as ProgressMirror)

test('a block with no end marker that more of the file follows is cut off, and one at the end of the file is not', () => {
  expect(cutOffBlocks(BOARD)).toEqual([{ line: 5, project: 'demo-152', session: '55fb44cb', agent: 'codex', updated: Date.parse('2026-10-20T01:17:08.128Z') }])
  expect(cutOffBlocks([...BEFORE, ''].join('\n'))).toEqual([])
  expect(cutOffBlocks([...BEFORE, '', '', ''].join('\n'))).toEqual([])
  expect(cutOffBlocks([...BEFORE.slice(0, 5), '### Add a shelf', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n'))).toEqual([])
})

test('the question pass reads a board with a block cut off in the middle, and still waits for one cut off at the end', () => {
  expect(isQuestionSnapshot(BOARD)).toBe(true)
  expect(isQuestionSnapshot([...BEFORE, ''].join('\n'))).toBe(false)
})

test('a block with no end marker followed only by text a reader may catch halfway is not taken as cut off', () => {
  // A step after a blank line, a fence or a comment may be the rest of a block still being written;
  // only a `##` heading, a block start or a block end comes after a writer is done with it.
  for (const tail of [['', '- [?] Ship it, OK?'], ['```', 'code'], ['<!-- note', 'more']]) {
    const text = ['## demo', '', CUT, '### Add a shelf', ...tail].join('\n')
    expect(cutOffBlocks(text)).toEqual([])
    expect(isQuestionSnapshot(text)).toBe(false)
  }
})

test('a block whose own end marker was cut is named once, by the line about the cut-off end', () => {
  const text = [...BEFORE.slice(0, 5), '### Add a shelf', '- [ ] Step', '<!-- /auto session=55fb', ...AFTER].join('\n')
  expect(progressTail(text)).not.toBeNull()
  expect(cutOffBlocks(text)).toEqual([])
  expect(cutOffScopes(parseProgress(text), cutOffSpans(text)).size).toBe(1)
})

test('cutBlockLines words each cut-off block by agent and date in all three languages, without line numbers or session ids', () => {
  const day = localDay(Date.parse('2026-10-20T01:17:08.128Z')).slice(5)
  for (const lang of ['en', 'zh-TW', 'zh-CN'] as const) {
    const [line] = cutBlockLines(cutOffBlocks(BOARD), STRINGS[lang])
    expect(line).toBe(STRINGS[lang].blockCutOff('Codex', day))
    expect(line).toContain('Codex')
    expect(line).toContain(day)
    expect(line).not.toContain('<!--')
    expect(line).not.toContain('55fb44cb')
    expect(line).not.toContain('line 5')
    expect(line).not.toContain('第 5 行')
    expect(line).not.toContain('progress.md')
  }
})

test('a cut-off block with no updated stamp is named without a day', () => {
  const day = localDay(Date.parse('2026-10-20T01:17:08.128Z')).slice(5)
  expect(cutBlockLines([
    { line: 5, project: 'demo-152', session: '55fb44cb', agent: 'openclaw', updated: null },
    { line: 9, project: 'demo-154', session: '1d0ef21d', agent: '', updated: null },
    { line: 12, project: 'demo-154', session: '9a9a9a9a', agent: 'custom', updated: Date.parse('2026-10-20T01:17:08.128Z') },
  ], EN)).toEqual([
    "An OpenClaw task was cut off when its session crashed. It's shown as it was; its last lines may show twice.",
    "A task was cut off when its session crashed. It's shown as it was; its last lines may show twice.",
    `A custom task from ${day} was cut off when its session crashed. It's shown as it was; its last lines may show twice.`,
  ])
  expect(cutBlockLines([{ line: 5, project: 'demo-152', session: '55fb44cb', agent: 'codex', updated: null }], STRINGS['zh-TW'])).toEqual([
    '一個 Codex 工作在 session 當掉時被截斷了，照原樣顯示；最後幾行可能會出現兩次。',
  ])
  expect(cutBlockLines([{ line: 5, project: 'demo-152', session: '55fb44cb', agent: 'codex', updated: null }], STRINGS['zh-CN'])).toEqual([
    '一个 Codex 工作在 session 崩溃时被截断了，按原样显示；最后几行可能会出现两次。',
  ])
})

test('progress.html lists a cut-off block in a details element at the end, not in the alert line', () => {
  const day = localDay(Date.parse('2026-10-20T01:17:08.128Z')).slice(5)
  const health = cutBlockLines(cutOffBlocks(BOARD), EN)
  const notice = EN.blockCutOff('Codex', day)
  const view = { ...buildView(parseProgress(BOARD), [], null, NOW, 0, {}, EN), health }
  const html = dashboardHtml(view, EN, '/home/me/.claude/progress.md', 'updated 12:00')
  expect(html).toContain('<details class="section sec" data-key="section:health">')
  expect(html).toContain(EN.sectionHealth)
  expect(html).toContain(notice)
  expect(html).not.toContain('role="status"')
  expect(html.indexOf('data-key="section:health"')).toBeGreaterThan(html.indexOf('</footer>'))
})

test('the text board lists a cut-off block on a muted line at the bottom', () => {
  const day = localDay(Date.parse('2026-10-20T01:17:08.128Z')).slice(5)
  const health = cutBlockLines(cutOffBlocks(BOARD), EN)
  const notice = EN.blockCutOff('Codex', day)
  const view = { ...buildView(parseProgress(BOARD), [], null, NOW, 0, {}, EN), health }
  const state = { selected: 0, key: null, open: null, seen: null, note: '' }
  // Wide enough for the whole notice on one row; at 80 columns it wraps onto rows that fit, as
  // recovery advice does, and loses no word.
  expect(boardText(view, [], EN, { width: 120, isColor: true }).trimEnd().endsWith(`\u001b[2m${notice}\u001b[0m`)).toBe(true)
  expect(boardScreen(view, [], state, EN, { width: 120, isColor: true }).trimEnd().endsWith(`\u001b[2m${notice}\u001b[0m`)).toBe(true)
  for (const out of [boardText(view, [], EN, { width: 80, isColor: true }), boardScreen(view, [], state, EN, { width: 80, isColor: true })]) {
    const tail = out.trimEnd().split('\n').slice(-2)
    expect(tail.every(line => line.startsWith('\u001b[2m') && line.endsWith('\u001b[0m'))).toBe(true)
    const parts = tail.map(line => line.slice(4, -4))
    expect(parts.join(' ')).toBe(notice)
    expect(parts.every(part => part.length <= 78)).toBe(true)
  }
  const chat = chatText(view, [], [], EN, '/home/me', false)
  expect(chat).not.toContain(notice)
  expect(chat).not.toContain(EN.sectionHealth)
})

test("a cut-off block's agent name reaches the notice, the text board and its screen with no control characters", () => {
  const board = BOARD.replace('agent=codex', 'agent=co\u001b[2Jde\u0007x')
  const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/
  // The notice every surface shows has the codes out already.
  const health = cutBlockLines(cutOffBlocks(board), EN)
  expect(health).toHaveLength(1)
  expect(health[0]).toContain('co[2Jdex')
  expect(health[0]).not.toMatch(controls)
  // And the terminal takes them out of a health line that still holds them.
  const raw = health.map(line => line.replace('co[2Jdex', 'co\u001b[2Jde\u0007x'))
  const view = { ...buildView(parseProgress(board), [], null, NOW, 0, {}, EN), health: raw }
  const state = { selected: 0, key: null, open: null, seen: null, note: '' }
  for (const out of [boardText(view, [], EN, { width: 200, isColor: false }), boardScreen(view, [], state, EN, { width: 200, isColor: false })]) {
    expect(out).toContain('co[2Jdex')
    expect(out).not.toMatch(controls)
  }
})

test('a cut-off block\'s own session rewrites only that block and gives it its end marker, and every section after it stays', () => {
  const next = upsertAutoBlock(BOARD, mirror('55fb44cb-synthetic', 'demo-152'), EN)
  expect(next.endsWith(['### Add a shelf', '> waiting on your repl', ...AFTER].join('\n'))).toBe(true)
  expect(next).toContain('<!-- /auto session=55fb44cb -->')
  expect(cutOffBlocks(next)).toEqual([])
})

test('another session\'s block after a cut-off block is rewritten in its place, and the cut-off block and the rest stay', () => {
  const next = upsertAutoBlock(BOARD, mirror('1d0ef21d-synthetic', 'demo-154'), EN)
  expect(next.startsWith(BEFORE.join('\n'))).toBe(true)
  expect(next).not.toContain('- [?] Ship it, OK?')
  expect(next).toContain([...DONE, '', ...HAND, ''].join('\n'))
  expect(next.match(/<!-- \/auto session=1d0ef21d -->/g)).toHaveLength(1)
})

test('a new block and a quick-add task under a cut-off block\'s heading go below it, and nothing after it moves', () => {
  for (const next of [upsertAutoBlock(BOARD, mirror('7c7c7c7c-synthetic', 'demo-152'), EN), addManualTask(BOARD, { project: 'demo-152', title: 'Quick task', due: null, steps: ['One'] }, EN)]) {
    expect(next.startsWith(BEFORE.join('\n'))).toBe(true)
    expect(next.endsWith(FOLLOWING)).toBe(true)
    expect(scanBlocks(next.split('\n')).find(span => span.session === '55fb44cb')?.end).toBe(6)
  }
})

test('removing a cut-off block removes only its lines, and removing the next block leaves the cut-off one', () => {
  expect(removeAutoBlock(BOARD, '55fb44cb')).toBe(['# Progress', '', '## demo-152', '', '### Add a shelf', '> waiting on your repl', ...AFTER].join('\n'))
  const next = removeAutoBlock(BOARD, '1d0ef21d')
  expect(next.startsWith(BEFORE.join('\n'))).toBe(true)
  expect(next).toContain([...DONE, '', ...HAND, ''].join('\n'))
})

test('the archive never takes a cut-off block, and takes a finished block after it alone', () => {
  const archived = takeArchivable(BOARD, NOW + 30 * DAY, undefined, EN, true)
  expect(archived.entries).toHaveLength(1)
  expect(archived.entries[0]).toContain('A finished plan')
  expect(archived.entries[0]).not.toContain('Add a shelf')
  expect(archived.entries[0]).not.toContain('Keep me')
  expect(archived.text.startsWith(BEFORE.join('\n'))).toBe(true)
  expect(archived.text).toContain(OTHER.join('\n'))
  expect(archived.text).toContain(HAND.join('\n'))
  expect(takeTask(BOARD, { project: 'demo-152', session: '55fb44cb', title: 'Add a shelf', line: 5 }, NOW + 30 * DAY, EN)).toBeNull()
})

test('a pasted block leaves a cut-off block of its session alone', () => {
  const pasted = [CUT.replace('2026-10-20T01:17:08.128Z', '2026-10-22T11:00:00Z'), '### Pasted', '- [ ] Pasted step', '<!-- /auto session=55fb44cb -->'].join('\n')
  expect(mergeBlock(BOARD, pasted, NOW, EN)).toEqual({ problem: 'notYours' })
})

test("a local report for its own block cut off in the middle writes its block in place of the marker line, and the cut block's lines and every section after them stay", () => {
  const board = BOARD.replace(CUT, CUT_MARKER)
  const next = putCodexBlock(board, { session: 'synthetic', agent: 'codex', project: 'demo-152', title: 'Codex plan', steps: ['- [ ] Step'], state: 'working', updated: new Date(NOW).toISOString() } as Parameters<typeof putCodexBlock>[1], OWNER)
  expect(next).toBe([
    '# Progress', '', '## demo-152', '',
    `<!-- auto session=aaaaaaaa agent=codex source=codex-local owner=${OWNER} state=working updated=2026-10-22T12:00:00.000Z resume=synthetic -->`,
    '### Codex plan',
    '- [ ] Step',
    '<!-- /auto session=aaaaaaaa -->',
    '### Add a shelf',
    '> waiting on your repl',
    ...AFTER,
  ].join('\n'))
})

test("the own session's upsert of a block cut right after its marker keeps the hand-kept task under it byte for byte", () => {
  const next = upsertAutoBlock(P0, mirror('aaaaaaaa-synthetic', 'demo-152'), EN)
  expect(next).toBe([
    '# Progress', '', '## demo-152', '',
    '<!-- auto session=aaaaaaaa agent=codex state=waiting updated=2026-10-22T12:00:00.000Z resume=aaaaaaaa-synthetic source=turns -->',
    '### Rewritten plan',
    '> Waiting for your next message',
    '- [ ] Next step',
    '<!-- /auto session=aaaaaaaa -->',
    P0_TAIL,
  ].join('\n'))
})

test("the own session's removal of a block cut right after its marker removes only the marker line", () => {
  expect(removeAutoBlock(P0, 'aaaaaaaa')).toBe(['# Progress', '', '## demo-152', '', P0_TAIL].join('\n'))
})

test('a local report for a block cut right after its marker writes its block in place of the marker line and keeps the hand-kept task', () => {
  const next = putCodexBlock(P0, { session: 'synthetic', agent: 'codex', project: 'demo-152', title: 'Codex plan', steps: ['- [ ] Step'], state: 'working', updated: new Date(NOW).toISOString() } as Parameters<typeof putCodexBlock>[1], OWNER)
  expect(next).toBe([
    '# Progress', '', '## demo-152', '',
    `<!-- auto session=aaaaaaaa agent=codex source=codex-local owner=${OWNER} state=working updated=2026-10-22T12:00:00.000Z resume=synthetic -->`,
    '### Codex plan',
    '- [ ] Step',
    '<!-- /auto session=aaaaaaaa -->',
    P0_TAIL,
  ].join('\n'))
})

test('the lines left from a cut-off block make no open question and no waiting row', () => {
  const next = upsertAutoBlock(BOARD, mirror('55fb44cb-synthetic', 'demo-152'), EN)
  const projects = parseProgress(next)
  expect(projects.flatMap(project => project.tasks).filter(task => task.auto?.session === '55fb44cb').map(task => task.title)).toEqual(['Rewritten plan'])
  const liveAt = Date.parse('2026-10-20T05:00:00.000Z')
  const view = buildView(projects, [], null, liveAt, 0, {}, EN)
  expect(view.waiting.map(item => item.text)).toEqual(['Ship it, OK?'])
  expect(observeQuestions(emptyQuestions(), projects, null, [], liveAt, true, 'after').ledger.records.map(record => record.words)).toEqual(['Ship it, OK?'])
})

test('a leftover title with open steps reads as a hand-kept task', () => {
  const text = ['# Progress', '', '## demo-152', '', CUT, '### old', '- [ ] step', ...AFTER].join('\n')
  const next = upsertAutoBlock(text, mirror('55fb44cb-synthetic', 'demo-152'), EN)
  const projects = parseProgress(next)
  expect(projects.find(project => project.name === 'demo-152')?.tasks.map(task => ({ title: task.title, session: task.auto?.session ?? null, steps: task.steps.map(step => [step.status, step.text]) }))).toEqual([
    { title: 'Rewritten plan', session: '55fb44cb', steps: [['todo', 'Next step']] },
    { title: 'old', session: null, steps: [['todo', 'step']] },
  ])
  const view = buildView(projects, [], null, NOW, 0, {}, EN)
  expect(view.active.find(row => row.title === 'old')).toMatchObject({ project: 'demo-152', title: 'old', auto: null, done: 0, total: 1, left: ['step'] })
})

test('the hand-kept task right after a cut marker stays on the board', () => {
  for (const next of [
    upsertAutoBlock(P0, mirror('aaaaaaaa-synthetic', 'demo-152'), EN),
    removeAutoBlock(P0, 'aaaaaaaa'),
    putCodexBlock(P0, { session: 'synthetic', agent: 'codex', project: 'demo-152', title: 'Codex plan', steps: ['- [ ] Step'], state: 'working', updated: new Date(NOW).toISOString() } as Parameters<typeof putCodexBlock>[1], OWNER),
  ]) {
    const tasks = parseProgress(next).find(project => project.name === 'demo-152')?.tasks ?? []
    expect(tasks.filter(task => task.auto === null).map(task => ({ title: task.title, steps: task.steps.map(step => [step.status, step.text]) }))).toEqual([
      { title: 'Hand-kept task', steps: [['todo', 'Keep me']] },
    ])
  }
})

test('no writer deletes or rewraps the text a cut-off block left', () => {
  const report = (title: string): Parameters<typeof putCodexBlock>[1] => ({ session: 'synthetic', agent: 'codex', project: 'demo-152', title, steps: ['- [ ] Step'], state: 'working', updated: new Date(NOW).toISOString() } as Parameters<typeof putCodexBlock>[1])
  const first = upsertAutoBlock(P0, mirror('aaaaaaaa-synthetic', 'demo-152'), EN)
  const second = upsertAutoBlock(first, { ...mirror('aaaaaaaa-synthetic', 'demo-152'), title: 'Second plan', updated: NOW + 1000 }, EN)
  const reported = putCodexBlock(putCodexBlock(P0, report('First report'), OWNER), report('Second report'), OWNER)
  const removed = removeAutoBlock(second, 'aaaaaaaa')
  const finished = upsertAutoBlock(second, { ...mirror('aaaaaaaa-synthetic', 'demo-152'), state: 'done', tasks: [{ ...mirror('aaaaaaaa-synthetic', 'demo-152').tasks[0]!, status: 'completed' }] }, EN)
  const archived = takeArchivable(finished, NOW + 30 * DAY, undefined, EN, true).text
  for (const text of [first, second, reported, removed]) expect(text.endsWith(`\n${P0_TAIL}`)).toBe(true)
  expect(archived.includes(`\n## demo-152\n\n### Hand-kept task\n- [ ] Keep me\n`)).toBe(true)
})

test('a question in a block cut off in the middle keeps its record and its hide, and has the same id once the block is whole', () => {
  const asking = ['### Add a shelf', '- [?] Ship the shelf, OK?', '- [?] Paint it, OK?']
  const whole = [...BEFORE.slice(0, 5), ...asking, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const idOf = (ledger: typeof seeded, words: string): string[] => ledger.records.filter(record => record.isPresent && record.words === words).map(record => record.id)
  const [shipped] = idOf(seeded, 'Ship the shelf, OK?')
  const [painted] = idOf(seeded, 'Paint it, OK?')
  expect(shipped).toBeDefined()
  expect(painted).toBeDefined()
  // The person hides the first; the second is still open.
  const hidden = resolveQuestion(seeded, shipped!, NOW)
  for (const mid of [
    ['### Add a shelf'],
    [...asking, '<!-- /auto session=55fb44cb'],
    ['### Add a shelf', '- [?] Ship the shelf, OK?', '- [?] Paint it, O', '<!-- question=ab'],
  ]) {
    const cut = [...BEFORE.slice(0, 5), ...mid, ...AFTER].join('\n')
    const cutProjects = parseProgress(cut)
    const frozen = cutOffScopes(cutProjects, cutOffSpans(cut))
    expect(frozen.size).toBe(1)
    // Without the cut-off block held as it was, the settled pass would count both as gone or record a garbled question.
    if (mid.length === 1) expect(resolvedQuestionsToRetire(hidden, cutProjects, null, [])).toContain(shipped)
    expect(resolvedQuestionsToRetire(hidden, cutProjects, null, [], frozen)).toEqual([])
    const during = observeQuestions(hidden, cutProjects, null, [], NOW + 1000, true, 'cut', undefined, [], [], frozen).ledger
    expect(during.records.find(record => record.id === shipped)).toEqual(hidden.records.find(record => record.id === shipped))
    expect(during.records.find(record => record.id === painted)).toEqual(hidden.records.find(record => record.id === painted))
    expect(during.records.some(record => record.words === 'Paint it, O')).toBe(false)
    const after = observeQuestions(during, parseProgress(whole), null, [], NOW + 2000, true, 'whole').ledger
    expect(after.records.filter(record => record.words === 'Ship the shelf, OK?').map(record => [record.id, record.resolvedAt])).toEqual([[shipped, NOW]])
    expect(idOf(after, 'Paint it, OK?')).toEqual([painted])
    expect(after.records.find(record => record.id === painted)?.isWaiting).toBe(true)
  }
})

test('a pending inbox turn of a block cut off in the middle adds no question, and the question keeps its id and its hide once the block is whole', () => {
  const head = BEFORE.slice(0, 5)
  const whole = [...head, '### Add a shelf', '- [?] Ship the shelf, OK?', `<!-- question=${'b'.repeat(64)}:1 -->`, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const ship = seeded.records.find(record => record.words === 'Ship the shelf, OK?')!
  expect(ship.producer).toBe(`${'b'.repeat(64)}:1`)
  const hidden = resolveQuestion(seeded, ship.id, NOW)
  const pending: PendingTurn = { id: '55fb44cb', agent: 'codex', project: 'demo-152', text: ship.words, isQuestion: true, at: NOW }
  const cut = [...head, '### Add a shelf', '- [?] Ship the shelf, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const during = observeQuestions(hidden, projects, null, [], NOW + 1000, true, 'cut', undefined, [pending], [], frozen).ledger
  expect(during.records.map(record => record.id)).toEqual(hidden.records.map(record => record.id))
  expect(during.records.find(record => record.id === ship.id)).toEqual(hidden.records.find(record => record.id === ship.id))
  const after = observeQuestions(during, parseProgress(whole), null, [], NOW + 2000, true, 'whole', undefined, [pending]).ledger
  expect(after.records.filter(record => record.words === ship.words).map(record => record.id)).toEqual([ship.id])
  expect(after.records.find(record => record.id === ship.id)).toMatchObject({ isUnresolved: false, resolvedAt: NOW })
})

test('a block cut right after its marker keeps its question unresolved with the same id until the whole block returns', () => {
  for (const [heading, marker] of [
    ['', CUT],
    ['## demo-152', CUT.replace('agent=codex', 'agent=Codex')],
    ['## #work ###', CUT.replace(' agent=codex', '')],
  ]) {
    const head = [heading, marker]
    const whole = [...head, '### Add a shelf', '- [?] Paint it, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
    const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
    const paint = seeded.records.find(record => record.words === 'Paint it, OK?')!
    for (const tail of [AFTER, OTHER]) {
      const cut = [...head, ...tail].join('\n')
      const projects = parseProgress(cut)
      const frozen = cutOffScopes(projects, cutOffSpans(cut))
      expect(frozen.has(paint.scope)).toBe(true)
      expect(projects.flatMap(project => project.tasks).some(task => task.auto?.session === '55fb44cb')).toBe(false)
      let during = seeded
      for (let pass = 1; pass <= 3; pass += 1) {
        during = observeQuestions(during, projects, null, [], NOW + pass * 1000, true, `cut-${pass}`, undefined, [], [], frozen).ledger
        expect(during.records.find(record => record.id === paint.id)).toEqual(paint)
        expect(resolvedQuestionsToRetire(during, projects, null, [], frozen)).toEqual([])
      }
      const restored = observeQuestions(during, parseProgress(whole), null, [], NOW + 4000, true, 'whole').ledger
      expect(restored.records.filter(record => record.words === paint.words).map(record => record.id)).toEqual([paint.id])
      expect(restored.records.find(record => record.id === paint.id)).toMatchObject({ isUnresolved: true, isPresent: true, isWaiting: true })
    }
  }
})

test('a frozen question appears once in full in the view and never as its cut-off prefix', () => {
  const head = BEFORE.slice(0, 5)
  const whole = [...head, '### Add a shelf', '- [?] Paint it, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const ledger = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const cut = [...head, '### Add a shelf', '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const cache = viewCache()
  cache.view(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], new Set())
  const view = cache.view(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
  const shown = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? []), ...view.hidden].filter(item => item.project === 'demo-152')
  expect(shown.map(item => item.text)).toEqual(['Paint it, OK?'])
  expect(shown.map(item => item.questionId)).toEqual(ledger.records.filter(record => record.words === 'Paint it, OK?').map(record => record.id))
  expect(cache.built()).toBe(2)
  expect(cache.view(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], new Set(frozen))).toBe(view)
  expect(cache.built()).toBe(2)
})

test('a frozen waiting task shows only its saved question until it is marked answered', () => {
  const marker = CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const head = [...BEFORE.slice(0, 4), marker, '### Add a shelf', '- [~] Sand the shelf']
  const whole = [...head, '- [?] Paint it, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const ledger = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const paint = ledger.records.find(record => record.words === 'Paint it, OK?')!
  const cut = [...head, '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  expect(frozen.has(paint.scope)).toBe(true)
  const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
  expect(view.active.some(item => item.project === 'demo-152')).toBe(false)
  const shown = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.project === 'demo-152')
  expect(shown.map(item => item.text)).toEqual(['Paint it, OK?'])
  expect(shown.map(item => item.questionId)).toEqual([paint.id])
  const answered = buildView(projects, [], null, NOW, 0, {}, EN, [paint.id], {}, ledger, undefined, [], frozen)
  const row = answered.active.find(item => item.project === 'demo-152')
  expect(row).toMatchObject({ title: 'Add a shelf', question: null, auto: 'waiting' })
  expect(row?.steps.map(step => step.text)).toEqual(['Sand the shelf', 'Paint it, O'])
  expect([...answered.waiting, ...(answered.reminder ?? []), ...(answered.older ?? [])].some(item => item.project === 'demo-152')).toBe(false)
  expect(answered.hidden.filter(item => item.project === 'demo-152').map(item => [item.questionId, item.text])).toEqual([[paint.id, 'Paint it, OK?']])
})

test('a frozen waiting task with no saved question lists its open step in Waiting on you without recording it', () => {
  const marker = CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const cut = [...BEFORE.slice(0, 4), marker, '### Add a shelf', '- [~] Sand the shelf', '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  for (const ledger of [emptyQuestions(), undefined]) {
    const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
    const asks = view.waiting.filter(item => item.project === 'demo-152')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ text: 'Paint it, O', hideKey: '' })
    expect(asks[0]?.questionId).toBeUndefined()
    expect(view.active.some(item => item.project === 'demo-152')).toBe(false)
    expect(view.focus).toEqual({ type: 'ask', item: asks[0] })
  }
  const hand = [...HAND, '- [?] Keep me, OK?']
  const p0 = P0.replace(HAND.join('\n'), hand.join('\n')).replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const p0Projects = parseProgress(p0)
  const p0Frozen = cutOffScopes(p0Projects, cutOffSpans(p0))
  for (const ledger of [emptyQuestions(), undefined]) {
    const view = buildView(p0Projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], p0Frozen)
    const asks = view.waiting.filter(item => item.project === 'demo-152')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ text: 'Keep me, OK?', hideKey: '' })
    expect(asks[0]?.questionId).toBeUndefined()
    expect(view.active.some(item => item.project === 'demo-152')).toBe(false)
    expect(view.focus).toEqual({ type: 'ask', item: asks[0] })
  }
})

test("a frozen block's step stays out of Waiting on you while cut off only when its answered saved question has its token", () => {
  const head = [...BEFORE.slice(0, 4), CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString()), '### Add a shelf', '- [?] Ship the shelf, OK?', `<!-- question=${'c'.repeat(64)}:1 -->`]
  const whole = [...head, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const ship = seeded.records.find(record => record.words === 'Ship the shelf, OK?')!
  const ledger = resolveQuestion(seeded, ship.id, NOW)
  const cut = [...head, ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
  expect([...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].some(item => item.project === 'demo-152')).toBe(false)
  const withoutToken = [...head.slice(0, -1), ...AFTER].join('\n')
  const tokenless = parseProgress(withoutToken)
  const unrecorded = buildView(tokenless, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], cutOffScopes(tokenless, cutOffSpans(withoutToken)))
  const asks = unrecorded.waiting.filter(item => item.project === 'demo-152')
  expect(asks).toHaveLength(1)
  expect(asks[0]).toMatchObject({ text: 'Ship the shelf, OK?', hideKey: '' })
  expect(asks[0]?.questionId).toBeUndefined()
})

test('a question hidden on the pane stays hidden while its block is cut off and once it is whole, and an open step beside it shows unrecorded', () => {
  const head = [...BEFORE.slice(0, 4), CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString()), '### Add a shelf', '- [?] Ship the shelf, OK?', `<!-- question=${'c'.repeat(64)}:1 -->`]
  const whole = [...head, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const ship = seeded.records.find(record => record.words === 'Ship the shelf, OK?')!
  const answered = [ship.id]
  const hidden = resolveQuestion(seeded, ship.id, NOW)
  const cut = [...head, '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const during = observeQuestions(hidden, projects, null, answered, NOW + 1000, true, 'cut', undefined, [], [], frozen).ledger
  expect(during.records.find(record => record.id === ship.id)).toEqual(hidden.records.find(record => record.id === ship.id))
  const view = buildView(projects, [], null, NOW + 1000, 0, {}, EN, answered, {}, during, undefined, [], frozen)
  const shown = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.project === 'demo-152')
  expect(shown).toHaveLength(1)
  expect(shown[0]).toMatchObject({ text: 'Paint it, O', hideKey: '' })
  expect(shown[0]?.questionId).toBeUndefined()
  const restored = [...head, '- [?] Paint it, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const after = observeQuestions(during, parseProgress(restored), null, answered, NOW + 2000, true, 'whole').ledger
  expect(after.records.filter(record => record.words === ship.words).map(record => [record.id, record.resolvedAt])).toEqual([[ship.id, NOW]])
  const painted = after.records.filter(record => record.words === 'Paint it, OK?')
  expect(painted).toHaveLength(1)
  const final = buildView(parseProgress(restored), [], null, NOW + 2000, 0, {}, EN, answered, {}, after)
  expect(final.waiting.filter(item => item.project === 'demo-152').map(item => [item.text, item.questionId])).toEqual([['Paint it, OK?', painted[0]!.id]])
})

test('a question asked again under a new revision before the pass sees it shows while its block is cut off, not hidden by the old answer', () => {
  const head = [...BEFORE.slice(0, 4), CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString()), '### Add a shelf', '- [?] Paint it, OK?']
  const token = `${'d'.repeat(64)}:1`
  const whole = [...head, `<!-- question=${token} -->`, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const seeded = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const paint = seeded.records.find(record => record.words === 'Paint it, OK?')!
  const answered = [paint.id]
  const hidden = resolveQuestion(seeded, paint.id, NOW)
  for (const revision of [1, 2]) {
    const cut = [...head, `<!-- question=${'d'.repeat(64)}:${revision} -->`, ...AFTER].join('\n')
    const projects = parseProgress(cut)
    const view = buildView(projects, [], null, NOW, 0, {}, EN, answered, {}, hidden, undefined, [], cutOffScopes(projects, cutOffSpans(cut)))
    const asks = view.waiting.filter(item => item.project === 'demo-152')
    expect(asks).toHaveLength(revision === 1 ? 0 : 1)
    if (revision === 2) {
      expect(asks[0]).toMatchObject({ text: paint.words, hideKey: '' })
      expect(asks[0]?.questionId).toBeUndefined()
    }
  }
  // Asked again while the first ask is still open: both show, the new one not yet recorded.
  const renewed = [...head, `<!-- question=${'d'.repeat(64)}:2 -->`, ...AFTER].join('\n')
  const renewedProjects = parseProgress(renewed)
  const open = buildView(renewedProjects, [], null, NOW, 0, {}, EN, [], {}, seeded, undefined, [], cutOffScopes(renewedProjects, cutOffSpans(renewed)))
  expect(open.waiting.filter(item => item.project === 'demo-152').map(item => `${item.text} ${item.questionId ?? 'unrecorded'}`).sort()).toEqual([`${paint.words} ${paint.id}`, `${paint.words} unrecorded`].sort())
  const r1 = '1'.repeat(64)
  const r2 = '2'.repeat(64)
  const ledger = { ...hidden, records: hidden.records.map(record => record.id === paint.id ? { ...record, producer: '', producerRevisions: [r1] } : record) }
  const cut = [...head, ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  for (const revision of [r1, r2]) {
    const pending: PendingTurn = { id: '55fb44cb', agent: 'codex', project: 'demo-152', text: paint.words, isQuestion: true, at: NOW, sourceRevisions: [revision] }
    const view = buildView(projects, [], null, NOW, 0, {}, EN, answered, {}, ledger, undefined, [pending], frozen)
    const asks = view.waiting.filter(item => item.project === 'demo-152')
    expect(asks).toHaveLength(revision === r1 ? 0 : 1)
    if (revision === r2) {
      expect(asks[0]).toMatchObject({ text: paint.words, hideKey: '' })
      expect(asks[0]?.questionId).toBeUndefined()
    }
  }
})

test('a cut step that two saved questions could have begun shows unrecorded, and so does one that only an answered question begins', () => {
  const head = [...BEFORE.slice(0, 4), CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString()), '### Add a shelf']
  const whole = [...head, '- [?] Deploy staging, OK?', `<!-- question=${'e'.repeat(64)}:1 -->`, '- [?] Deploy stage two, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const ledger = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const saved = ledger.records.filter(record => record.words.startsWith('Deploy st'))
  expect(saved).toHaveLength(2)
  const cut = [...head, '- [?] Deploy st', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
  const asks = view.waiting.filter(item => item.project === 'demo-152')
  const unrecorded = asks.filter(item => item.questionId === undefined)
  expect(unrecorded).toHaveLength(1)
  expect(unrecorded[0]).toMatchObject({ text: 'Deploy st', hideKey: '' })
  expect(asks.filter(item => item.questionId !== undefined).map(item => item.questionId).sort()).toEqual(saved.map(record => record.id).sort())
  const staging = saved.find(record => record.words === 'Deploy staging, OK?')!
  const hidden = resolveQuestion({ ...ledger, records: [staging] }, staging.id, NOW)
  const answered = buildView(projects, [], null, NOW, 0, {}, EN, [staging.id], {}, hidden, undefined, [], frozen)
  const remaining = answered.waiting.filter(item => item.project === 'demo-152')
  expect(remaining).toHaveLength(1)
  expect(remaining[0]).toMatchObject({ text: 'Deploy st', hideKey: '' })
  expect(remaining[0]?.questionId).toBeUndefined()
})

test('a question asked again before its block was cut shows once by its live record, not as the old answered one', () => {
  const marker = CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const head = [...BEFORE.slice(0, 4), marker, '### Add a shelf', '- [?] Paint it, OK?']
  const whole = [...head, '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const first = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const old = first.records.find(record => record.words === 'Paint it, OK?')!
  const proofs = { retired: [sha256(old.id)], consumed: [] }
  // The answered question is retired and asked again, so the ledger holds both, the old one first.
  const ledger = observeQuestions(resolveQuestion(first, old.id, NOW), parseProgress(whole), null, [], NOW + 1000, true, 'renewed', proofs).ledger
  const asked = ledger.records.filter(record => record.words === 'Paint it, OK?')
  expect(asked.map(record => record.isUnresolved)).toEqual([false, true])
  const cut = [...head, ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const view = buildView(projects, [], null, NOW + 2000, 0, {}, EN, [], {}, ledger, proofs, [], frozen)
  expect(view.active.some(item => item.project === 'demo-152')).toBe(false)
  const shown = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? []), ...view.hidden].filter(item => item.project === 'demo-152')
  expect(shown.map(item => item.questionId)).toEqual([asked[1]!.id])
})

test('a frozen working task keeps its row without a cut question and shows its saved question once', () => {
  const marker = CUT.replace('state=waiting', 'state=working').replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const head = [...BEFORE.slice(0, 4), marker, '### Add a shelf', '- [~] Sand the shelf']
  const whole = [...head, '- [?] Paint it, OK?', '<!-- /auto session=55fb44cb -->', ...AFTER].join('\n')
  const ledger = observeQuestions(emptyQuestions(), parseProgress(whole), null, [], NOW, true, 'seed').ledger
  const cut = [...head, '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], frozen)
  const row = view.active.find(item => item.project === 'demo-152')
  expect(row).toMatchObject({ title: 'Add a shelf', question: null, auto: 'working' })
  expect(row?.steps.map(step => step.text)).toEqual(['Sand the shelf', 'Paint it, O'])
  const shown = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? []), ...view.hidden].filter(item => item.project === 'demo-152')
  expect(shown.map(item => item.text)).toEqual(['Paint it, OK?'])
  expect(shown.map(item => item.questionId)).toEqual(ledger.records.filter(record => record.words === 'Paint it, OK?').map(record => record.id))
  const restored = buildView(parseProgress(whole), [], null, NOW, 0, {}, EN, [], {}, ledger)
  expect(restored.active.find(item => item.project === 'demo-152')?.question).toBe('Paint it, OK?')
})

test('a block cut off at the end of the file is read as ending there once the file has been still for 10 seconds', () => {
  const text = [...BEFORE, ''].join('\n')
  const day = localDay(Date.parse('2026-10-20T01:17:08.128Z')).slice(5)
  expect(CUT_SETTLE_MS).toBe(10_000)
  expect(isQuestionSnapshot(text, false)).toBe(false)
  expect(cutBlockLines(cutOffBlocks(text, false), EN)).toEqual([])
  expect(cutOffSpans(text, false)).toEqual([])
  expect(isQuestionSnapshot(text, true)).toBe(true)
  expect(cutBlockLines(cutOffBlocks(text, true), EN)).toEqual([EN.blockCutOff('Codex', day)])
  expect(cutOffScopes(parseProgress(text), cutOffSpans(text, true)).size).toBe(1)
})

test('torn question ledgers over a week old go even among the newest three, by the time in their names or else their own', () => {
  const path = '/home/me/.claude/progress.md'
  const ledger = 'progress-questions.json'
  const entries = [
    { name: `${ledger}.torn-${NOW - 3 * DAY}-synthetic-session`, mtimeMs: 1 },
    { name: `${ledger}.torn-${NOW - 7 * DAY - 1}-4242`, mtimeMs: NOW },
    // Moved aside by hand with a date and no time: its own time says how old it is.
    { name: `${ledger}.torn-20261019`, mtimeMs: NOW - 8 * DAY },
    { name: `${ledger}.torn-20261021`, mtimeMs: NOW - DAY },
  ]
  expect(ledgerLeftovers(path, entries, NOW).torn.sort()).toEqual([`${ledger}.torn-${NOW - 7 * DAY - 1}-4242`, `${ledger}.torn-20261019`])
  expect(ledgerLeftovers(path, entries.map(entry => entry.name.endsWith('-4242') ? { ...entry, name: `${ledger}.torn-${NOW - 7 * DAY}-4242` } : entry), NOW).torn).toEqual([`${ledger}.torn-20261019`])
  // Three only, so none goes for being past the newest three: a name with a date and no time,
  // dashed or not, goes by its own time alone.
  const byHand = [
    { name: `${ledger}.torn-2026-10-10-old`, mtimeMs: NOW - 8 * DAY },
    { name: `${ledger}.torn-2026-10-21-new`, mtimeMs: NOW - DAY },
    { name: `${ledger}.torn-20261021`, mtimeMs: NOW - 2 * DAY },
  ]
  expect(ledgerLeftovers(path, byHand, NOW).torn).toEqual([`${ledger}.torn-2026-10-10-old`])
})

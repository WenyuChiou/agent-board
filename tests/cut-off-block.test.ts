import { expect, test } from 'claude-code/testing'
import type { ProgressMirror } from '../types'
import { addManualTask, CUT_SETTLE_MS, cutBlockLines, cutOffBlocks, cutOffSpans, mergeBlock, removeAutoBlock, scanBlocks, takeArchivable, takeTask, upsertAutoBlock } from '../hooks/blocks'
import { boardScreen, boardText, chatText } from '../hooks/board'
import { dashboardHtml } from '../hooks/dashboard'
import { localDay } from '../hooks/journal'
import { parseProgress, progressTail } from '../hooks/parse'
import { putCodexBlock } from '../hooks/codex'
import { cutOffScopes, emptyQuestions, isQuestionSnapshot, ledgerLeftovers, observeQuestions, resolvedQuestionsToRetire, resolveQuestion } from '../hooks/questions'
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
  const text = boardText(view, [], EN, { width: 80, isColor: true })
  expect(text.trimEnd().endsWith(`\u001b[2m${notice}\u001b[0m`)).toBe(true)
  const screen = boardScreen(view, [], { selected: 0, key: null, open: null, seen: null, note: '' }, EN, { width: 80, isColor: true })
  expect(screen.trimEnd().endsWith(`\u001b[2m${notice}\u001b[0m`)).toBe(true)
  const chat = chatText(view, [], [], EN, '/home/me', false)
  expect(chat).not.toContain(notice)
  expect(chat).not.toContain(EN.sectionHealth)
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

test('a pasted block and the Codex reporter leave a cut-off block of their session alone', () => {
  const pasted = [CUT.replace('2026-10-20T01:17:08.128Z', '2026-10-22T11:00:00Z'), '### Pasted', '- [ ] Pasted step', '<!-- /auto session=55fb44cb -->'].join('\n')
  expect(mergeBlock(BOARD, pasted, NOW, EN)).toEqual({ problem: 'notYours' })
  expect(() => putCodexBlock(BOARD, { session: 'synthetic', agent: 'codex', project: 'demo-152', title: 'Codex plan', steps: ['- [ ] Step'], state: 'working', updated: new Date(NOW).toISOString() } as Parameters<typeof putCodexBlock>[1], '55fb44cb'.padEnd(64, 'a'))).toThrow('BLOCK_CONFLICT')
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

test('a frozen waiting task with no saved question stays visible with its steps and no question', () => {
  const marker = CUT.replace('2026-10-20T01:17:08.128Z', new Date(NOW).toISOString())
  const cut = [...BEFORE.slice(0, 4), marker, '### Add a shelf', '- [~] Sand the shelf', '- [?] Paint it, O', ...AFTER].join('\n')
  const projects = parseProgress(cut)
  const frozen = cutOffScopes(projects, cutOffSpans(cut))
  const view = buildView(projects, [], null, NOW, 0, {}, EN, [], {}, emptyQuestions(), undefined, [], frozen)
  const row = view.active.find(item => item.project === 'demo-152')
  expect(row).toMatchObject({ title: 'Add a shelf', question: null, auto: 'waiting', left: ['Sand the shelf', 'Paint it, O'] })
  expect(row?.steps.map(step => step.text)).toEqual(['Sand the shelf', 'Paint it, O'])
  expect([...view.waiting, ...(view.reminder ?? []), ...(view.older ?? []), ...view.hidden].some(item => item.text === 'Paint it, O')).toBe(false)
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

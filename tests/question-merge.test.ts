import { test, expect } from 'claude-code/testing'
import { emptyQuestions, observeQuestions, questionWords, resolveQuestion, withCaptures } from '../hooks/questions'
import type { QuestionLedger } from '../hooks/questions'
import { parseProgress } from '../hooks/parse'
import { buildView, questionHead, relativeTime } from '../hooks/view'
import type { View } from '../hooks/view'
import type { PendingTurn } from '../hooks/board'
import { boardItems, boardText, olderKey } from '../hooks/board'
import { applyTaskCreate, applyTaskUpdate, emptyMirror } from '../hooks/mirror'
import { folderOf } from '../hooks/question-merge'
import { serveModel } from '../hooks/serve'
import { STRINGS } from '../hooks/strings'

const EN = STRINGS.en
const START = Date.parse('2026-10-01T00:00:00Z')
const HOUR = 60 * 60 * 1000
const NOW = START + 3 * HOUR
const QUESTION = 'Ship the synthetic plan, OK?'

// A block of one agent's session that asks `question`; `updated` keeps it live at NOW.
const block = (session: string, agent: string, project: string, question: string, updated = NOW, dir: string | null = project === 'demo' || project === 'other-folder' ? `/work/${project}` : project): string =>
  `## ${project}\n<!-- auto session=${session} agent=${agent} state=waiting updated=${new Date(updated).toISOString()}${dir === null ? '' : ` dir=${encodeURIComponent(dir)}`} -->\n### Task ${session}\n- [?] ${question}\n<!-- /auto session=${session} -->\n`

const capture = (id: string, agent: string, project: string, text: string, at: number): PendingTurn => ({ id, agent, project, dir: `/work/${project}`, text, fullText: text, isQuestion: true, at })

// The ledger as the question pass writes it: each file read at the time given, one pass after another.
const ledgerOf = (passes: ReadonlyArray<{ text: string; at: number; pending?: PendingTurn[] }>): QuestionLedger =>
  passes.reduce((ledger, pass, index) => observeQuestions(ledger, parseProgress(pass.text), null, [], pass.at, true, `writer:${index}`, undefined, pass.pending ?? []).ledger, emptyQuestions())

const viewOf = (text: string, ledger: QuestionLedger, pending: PendingTurn[] = [], answered: string[] = [], now = NOW): View =>
  buildView(parseProgress(text), [], null, now, 0, {}, EN, answered, {}, ledger, undefined, pending)

test('one question from one turn is one row with its own time', () => {
  const words = 'Blue or green?'
  // One turn's question: its capture, then its block, then the block is rewritten with no question
  // and the turn asks again. Each pass leaves a record of the same session and the same words.
  const asked = block('aaaa1111', 'codex', 'demo', words)
  const quiet = asked.replace(`- [?] ${words}`, '- [~] Keep going')
  const captured = [capture('aaaa1111', 'codex', 'demo', words, START)]
  const ledger = ledgerOf([
    { text: quiet, at: START, pending: captured },
    { text: quiet, at: START + HOUR },
    { text: asked, at: START + 2 * HOUR },
    { text: quiet, at: START + 2 * HOUR + 1 },
    { text: asked, at: NOW - 10 * 60 * 1000 },
  ])
  expect(ledger.records.filter(record => record.isUnresolved).length).toBeGreaterThan(1)
  const view = viewOf(asked, ledger)
  const rows = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.task).toBe('Task aaaa1111')
  expect(rows[0]?.when).toBe(relativeTime(NOW - 10 * 60 * 1000, NOW, EN))
  // Every surface reads the same list: the page's model and the terminal board's lines.
  const model = serveModel(view, [], EN)
  expect([...model.asks, ...model.reminder, ...model.older].filter(item => item.text === words)).toHaveLength(1)
  expect(boardItems(view, [], true, true).filter(item => item.type === 'ask' && item.ask.text === words)).toHaveLength(1)
  expect(boardText(view, [], EN, { width: 200, isColor: false, isIdleOpen: true }).split(words)).toHaveLength(2)
})

test('a question from a turn with no task names no empty title on the terminal board or in its text', () => {
  const words = 'Blue or green?'
  const pending = [capture('aaaa1111', 'codex', 'demo', words, START)]
  const ledger = ledgerOf([{ text: '', at: START, pending }])
  const view = viewOf('', ledger, [], [], START + 8 * 24 * HOUR)
  const row = view.older?.[0] ?? view.reminder?.[0]
  expect(row?.task).toBe('')
  expect(questionHead(row?.project ?? '', row?.task ?? '')).toBe('demo')
  expect(questionHead('demo', 'A task')).toBe('demo › A task')
  const text = boardText(view, [], EN, { width: 200, isColor: false, isIdleOpen: true })
  expect(text).toContain(words)
  expect(text).not.toContain('›  ·')
})

test('a review-only copy answered in its own session leaves with the card it joined', () => {
  const words = 'Blue or green?'
  const asked = block('aaaa1111', 'codex', 'demo', words)
  const quiet = asked.replace(`- [?] ${words}`, '- [~] Keep going')
  const ledger = ledgerOf([
    { text: asked, at: START },
    { text: quiet, at: START + 1 },
    { text: asked, at: START + HOUR },
  ])
  const live = ledger.records.filter(record => record.isUnresolved).at(-1)!
  const resolved = resolveQuestion(ledger, live.id, START + 2 * HOUR)
  const view = viewOf(quiet, resolved)
  expect([...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)).toHaveLength(0)
})

test('a session with only review-only copies of a question keeps one row, the newest, with its own time', () => {
  const words = 'Blue or green?'
  const asked = block('aaaa1111', 'codex', 'demo', words)
  const quiet = asked.replace(`- [?] ${words}`, '- [~] Keep going')
  const ledger = ledgerOf([
    { text: asked, at: START },
    { text: quiet, at: START + 1 },
    { text: asked, at: START + HOUR },
    { text: quiet, at: START + HOUR + 1 },
  ])
  expect(ledger.records.filter(record => record.isUnresolved && record.words === questionWords(words)).length).toBeGreaterThan(1)
  const view = viewOf(quiet, ledger)
  const rows = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.canHide).toBe(false)
  expect(rows[0]?.when).toBe(relativeTime(START + HOUR, NOW, EN))
})

test("a capture with no task takes the title its session's review-only copy knew", () => {
  const words = 'Blue or green?'
  const asked = block('aaaa1111', 'codex', 'demo', words)
  const quiet = asked.replace(`- [?] ${words}`, '- [~] Keep going')
  const pending = [capture('aaaa1111', 'codex', 'demo', words, START + HOUR)]
  const ledger = ledgerOf([
    { text: asked, at: START },
    { text: quiet, at: START + 1 },
    { text: quiet, at: START + HOUR, pending },
  ])
  const view = viewOf(quiet, ledger, pending)
  const rows = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.key.startsWith('inbox::')).toBe(true)
  expect(rows[0]?.task).toBe('Task aaaa1111')
})

test('a same-session review-only copy takes no second row in its own pane or for a block with no folder', () => {
  const words = 'Blue or green?'
  const askedNoDir = block('aaaa1111', 'codex', 'demo', words, NOW, null)
  const quietNoDir = askedNoDir.replace(`- [?] ${words}`, '- [~] Keep going')
  const ledgerNoDir = ledgerOf([
    { text: askedNoDir, at: START },
    { text: quietNoDir, at: START + 1 },
    { text: askedNoDir, at: START + HOUR },
  ])
  const viewNoDir = viewOf(askedNoDir, ledgerNoDir)
  const rowsNoDir = [...viewNoDir.waiting, ...(viewNoDir.reminder ?? []), ...(viewNoDir.older ?? [])].filter(item => item.text === words)
  expect(rowsNoDir).toHaveLength(1)

  let mirror = emptyMirror('aaaa1111-session', 'demo', NOW, '/work/demo')
  mirror = { ...mirror, agent: 'claude' }
  mirror = applyTaskCreate(mirror, { subject: words }, '1', NOW)
  mirror = applyTaskUpdate(mirror, { taskId: '1', metadata: { waiting: 'you' } }, NOW)
  const askedClaude = block('aaaa1111', 'claude', 'demo', words)
  const quietClaude = askedClaude.replace(`- [?] ${words}`, '- [~] Keep going')
  const ledgerClaude = ledgerOf([
    { text: askedClaude, at: START },
    { text: quietClaude, at: START + 1 },
    { text: askedClaude, at: START + HOUR },
  ])
  const viewMine = buildView(parseProgress(quietClaude), [], mirror, NOW, 0, {}, EN, [], {}, ledgerClaude)
  const rowsMine = [...viewMine.waiting, ...(viewMine.reminder ?? []), ...(viewMine.older ?? [])].filter(item => item.text === words)
  expect(rowsMine).toHaveLength(1)
  expect(rowsMine[0]?.where).toBe('here')
})

test('a capture with no task takes the newest title its session knew', () => {
  const words = 'Blue or green?'
  const askedA = block('aaaa1111', 'codex', 'demo', words).replace('Task aaaa1111', 'Task A')
  const askedB = block('aaaa1111', 'codex', 'demo', words).replace('Task aaaa1111', 'Task B')
  const quietB = askedB.replace(`- [?] ${words}`, '- [~] Keep going')
  const pending = [capture('aaaa1111', 'codex', 'demo', words, START + 2 * HOUR)]
  const ledger = ledgerOf([
    { text: askedA, at: START },
    { text: askedB, at: START + HOUR },
    { text: quietB, at: START + HOUR + 1 },
    { text: quietB, at: START + 2 * HOUR, pending },
  ])
  const view = viewOf(quietB, ledger, pending)
  const rows = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.key.startsWith('inbox::')).toBe(true)
  expect(rows[0]?.task).toBe('Task B')
})

test('hiding a card beside an archived copy leaves no review-only row behind', () => {
  const words = 'Blue or green?'
  const asked = block('aaaa1111', 'codex', 'demo', words)
  const quiet = asked.replace(`- [?] ${words}`, '- [~] Keep going')
  const ledger = ledgerOf([
    { text: asked, at: START },
    { text: quiet, at: START + 1 },
    { text: asked, at: START + HOUR },
    { text: quiet, at: START + HOUR + 1 },
  ])
  ledger.records[0]!.isArchived = true
  const view = viewOf(quiet, ledger)
  const rows = [...view.waiting, ...(view.reminder ?? []), ...(view.older ?? [])].filter(item => item.text === words)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.canHide).toBe(true)

  const hidden = viewOf(quiet, ledger, [], [rows[0]!.hideKey])
  const hiddenRows = [...hidden.waiting, ...(hidden.reminder ?? []), ...(hidden.older ?? [])].filter(item => item.text === words)
  expect(hiddenRows).toHaveLength(0)
})

test('the same question in a block and in an inbox capture shows as one card', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION)
  const pending = [capture('cccc3333', 'codex', 'demo', `  ${QUESTION} `, START + HOUR)]
  const ledger = ledgerOf([{ text, at: START }, { text, at: START + HOUR, pending }])
  // Each copy has an id of its own: the page used to match copies by that id only.
  expect(ledger.records.filter(record => record.isUnresolved)).toHaveLength(2)
  const view = viewOf(text, ledger, pending)
  expect(view.waiting).toHaveLength(1)
  // The newest source, with its own time.
  expect(view.waiting[0]?.key.startsWith('inbox::')).toBe(true)
  expect(view.waiting[0]?.when).toBe(relativeTime(START + HOUR, NOW, EN))
  expect(serveModel(view, pending, EN).asks).toHaveLength(1)
  expect(serveModel(view, pending, EN).turns).toHaveLength(0)
  // The other copy stays in the question list.
  expect(ledger.records.filter(record => record.isUnresolved)).toHaveLength(2)
})

test('the same question in two blocks of one agent and folder shows as one card with the newest ask\'s time', () => {
  const files = [
    block('aaaa1111', 'codex', 'demo', QUESTION) + block('bbbb2222', 'codex', 'demo', `  Ship the   synthetic plan,  OK? `),
    // A Windows folder reads the same with either slash.
    block('aaaa1111', 'codex', 'C:\\work\\demo', QUESTION) + block('bbbb2222', 'codex', 'C:/work/demo/', QUESTION),
  ]
  for (const text of files) {
    const ledger = ledgerOf([{ text: text.replace(/## [^\n]*\n<!-- auto session=bbbb2222[\s\S]*$/, ''), at: START }, { text, at: START + HOUR }])
    const view = viewOf(text, ledger)
    expect(view.waiting).toHaveLength(1)
    expect(view.waiting[0]?.key).toContain('Task bbbb2222')
    expect(view.waiting[0]?.when).toBe(relativeTime(START + HOUR, NOW, EN))
    expect(view.overview.waiting).toBe(1)
  }
  expect(folderOf('C:\\a\\b')).toBe(folderOf('c:/a/b/'))
  expect(folderOf('\\\\host\\share')).not.toBe(folderOf('/host/share'))
})

test('the same words from two different agents show as two cards', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION) + block('bbbb2222', 'claude', 'demo', QUESTION) + block('cccc3333', 'codex', 'other-folder', QUESTION)
  const ledger = ledgerOf([{ text, at: START }])
  const view = viewOf(text, ledger)
  expect(view.waiting).toHaveLength(3)
  expect(new Set(view.waiting.map(item => item.agent || 'claude'))).toEqual(new Set(['codex', 'claude']))
  expect(serveModel(view, [], EN).asks).toHaveLength(3)
  expect(view.overview.waiting).toBe(3)
})

test('two blocks of one agent under one heading but in different folders show as two cards and Hide closes only the one', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION, NOW, '/work/one') + block('bbbb2222', 'codex', 'demo', QUESTION, NOW, '/work/two')
  const ledger = ledgerOf([{ text, at: START }])
  const shown = viewOf(text, ledger)
  expect(shown.waiting).toHaveLength(2)
  const hidden = viewOf(text, ledger, [], [shown.waiting[1]!.hideKey])
  expect(hidden.waiting.map(item => item.key)).toEqual([shown.waiting[0]!.key])
  expect(hidden.overview.waiting).toBe(1)
})

test('a question whose block has no folder stays its own card next to the same question in another block', () => {
  for (const dir of [null, '/work/demo']) {
    const text = block('aaaa1111', 'codex', 'demo', QUESTION, NOW, null) + block('bbbb2222', 'codex', 'demo', QUESTION, NOW, dir)
    const ledger = ledgerOf([{ text, at: START }])
    const shown = viewOf(text, ledger)
    expect(shown.waiting).toHaveLength(2)
    for (const card of shown.waiting) {
      expect(viewOf(text, ledger, [], [card.hideKey]).waiting.map(item => item.key)).toEqual(shown.waiting.filter(item => item !== card).map(item => item.key))
    }
  }
})

test('folders that differ only by a backslash or a trailing space in their name show as two cards', () => {
  // On a POSIX computer both are part of a folder's name; only a Windows path reads either slash the same.
  const backslash = String.fromCharCode(92)
  for (const [one, two] of [[`/work/a${backslash}b`, '/work/a/b'], ['/work/name ', '/work/name']] as const) {
    const text = block('aaaa1111', 'codex', 'demo', QUESTION, NOW, one) + block('bbbb2222', 'codex', 'demo', QUESTION, NOW, two)
    expect(viewOf(text, ledgerOf([{ text, at: START }])).waiting).toHaveLength(2)
  }
  expect(folderOf(`C:${backslash}work${backslash}demo`)).toBe(folderOf('c:/work/demo/'))
})

test('hiding or answering the one card closes every copy of it', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION) + block('bbbb2222', 'codex', 'demo', QUESTION)
  const pending = [capture('cccc3333', 'codex', 'demo', QUESTION, START + 2 * HOUR)]
  const ledger = ledgerOf([{ text: block('aaaa1111', 'codex', 'demo', QUESTION), at: START }, { text, at: START + HOUR }, { text, at: START + 2 * HOUR, pending }])
  const view = viewOf(text, ledger, pending)
  expect(view.waiting).toHaveLength(1)
  const card = view.waiting[0]!
  // Hide: one press on the one card, and the page has no card and counts nothing.
  const hidden = viewOf(text, ledger, pending, [card.hideKey])
  expect(hidden.waiting).toHaveLength(0)
  expect(hidden.reminder ?? []).toHaveLength(0)
  expect(hidden.older ?? []).toHaveLength(0)
  expect(hidden.overview.waiting).toBe(0)
  expect(serveModel(hidden, pending, EN).counts.waiting).toBe(0)
  expect(hidden.hidden).toHaveLength(1)
  // Showing it again brings back one card, not three.
  expect(viewOf(text, ledger, pending, []).waiting).toHaveLength(1)
  // Answer: the session of the shown copy goes on after the reply, which resolves that copy.
  const answered = observeQuestions(ledger, parseProgress(text), null, [], NOW, true, 'writer:answer', undefined, [], [{ agent: 'codex', id: 'cccc3333', event: 'turn', at: START + 2 * HOUR + 1 }]).ledger
  expect(viewOf(text, answered).waiting).toHaveLength(0)
  expect(viewOf(text, resolveQuestion(ledger, card.questionId ?? '', NOW), pending).waiting).toHaveLength(0)
  // A copy asked after the card was hidden is a new ask and shows.
  const later = text + block('dddd4444', 'codex', 'demo', QUESTION)
  const asked = ledgerOf([{ text, at: START + HOUR }, { text: later, at: NOW - 1 }])
  const first = viewOf(text, asked, [], [])
  const key = first.waiting[0]?.hideKey ?? ''
  expect(viewOf(later, asked, [], [key]).waiting.map(item => item.key)).toEqual([expect.stringContaining('Task dddd4444')])
})

test('the count beside Waiting on you counts the question once', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION) + block('bbbb2222', 'codex', 'demo', QUESTION)
  const pending = [capture('cccc3333', 'codex', 'demo', QUESTION, START + 2 * HOUR)]
  const ledger = ledgerOf([{ text: block('aaaa1111', 'codex', 'demo', QUESTION), at: START }, { text, at: START + HOUR }, { text, at: START + 2 * HOUR, pending }])
  const view = viewOf(text, ledger, pending)
  expect(view.overview.waiting).toBe(1)
  expect(view.waiting).toHaveLength(1)
  const model = serveModel(view, pending, EN)
  expect(model.counts.waiting).toBe(1)
  expect(model.asks).toHaveLength(1)
  // A second, different question still counts.
  const other = text + block('eeee5555', 'codex', 'demo', 'Pick a name or a date?')
  const both = viewOf(other, ledgerOf([{ text: other, at: START }]), [])
  expect(serveModel(both, [], EN).counts.waiting).toBe(2)
})

// A session that has ended and still holds the question.
const ended = (session: string, question: string, updated: number): string =>
  `## demo\n<!-- auto session=${session} agent=codex state=ended updated=${new Date(updated).toISOString()} dir=%2Fwork%2Fdemo -->\n### Task ${session}\n- [?] ${question}\n<!-- /auto session=${session} -->\n`

test('a stopped session\'s copy joins the live card instead of listing the question again', () => {
  const old = START - 10 * 24 * HOUR
  const stopped = ended('aaaa1111', QUESTION, old)
  const text = stopped + block('bbbb2222', 'codex', 'demo', QUESTION)
  const ledger = ledgerOf([{ text: stopped, at: old }, { text, at: START }])
  // Before the live copy came, the stopped session's task held the question.
  expect(viewOf(stopped, ledgerOf([{ text: stopped, at: old }])).stopped[0]?.question).toBe(QUESTION)
  const view = viewOf(text, ledger)
  // One card for the live session, with its own time; Older does not list the stopped copy a second
  // time, and the stopped task keeps its own.
  expect(view.waiting).toHaveLength(1)
  expect(view.waiting[0]?.key).toContain('Task bbbb2222')
  expect(view.waiting[0]?.when).toBe(relativeTime(START, NOW, EN))
  expect(view.older ?? []).toHaveLength(0)
  expect(view.stoppedAsking).toBeUndefined()
  expect(view.stopped).toHaveLength(1)
  expect(view.stopped[0]?.questions?.map(item => item.text)).toEqual([QUESTION])
  // Without the live copy, the stopped copy is listed under Older once.
  const alone = viewOf(stopped, ledgerOf([{ text: stopped, at: old }]))
  expect(alone.older?.map(item => item.text)).toEqual([QUESTION])
  expect(alone.stoppedAsking).toBe(1)
  // A stopped copy recorded after the live one does not take the card: the live session is the one to answer.
  const later = viewOf(text, ledgerOf([{ text: block('bbbb2222', 'codex', 'demo', QUESTION), at: START }, { text, at: START + HOUR }]))
  expect(later.waiting.map(item => item.key)).toEqual([expect.stringContaining('Task bbbb2222')])
  expect(later.overview.waiting).toBe(1)
  expect(later.older ?? []).toHaveLength(0)
})

test('two retained copies of one question show once under Older', () => {
  const old = START - 10 * 24 * HOUR
  const both = ended('aaaa1111', QUESTION, old) + ended('bbbb2222', QUESTION, old)
  // Both sessions' blocks are gone from the file; their questions stay in the question list.
  const ledger = ledgerOf([{ text: both, at: old }, { text: '## demo\n', at: old + HOUR }])
  expect(ledger.records.filter(record => record.isUnresolved)).toHaveLength(2)
  const view = viewOf('## demo\n', ledger)
  expect(view.older).toHaveLength(1)
  expect(view.waiting).toHaveLength(0)
  expect(serveModel(view, [], EN).older).toHaveLength(1)
})

test("hiding a question also hides a stopped session's copy that was recorded after it", () => {
  const live = block('aaaa1111', 'codex', 'demo', QUESTION)
  const text = live + ended('bbbb2222', QUESTION, START - 10 * 24 * HOUR)
  const ledger = ledgerOf([{ text: live, at: START }, { text, at: START + HOUR }])
  const shown = viewOf(text, ledger)
  expect(shown.waiting.map(item => item.key)).toEqual([expect.stringContaining('Task aaaa1111')])
  const hidden = viewOf(text, ledger, [], [shown.waiting[0]!.hideKey])
  expect(hidden.waiting).toHaveLength(0)
  expect(hidden.reminder ?? []).toHaveLength(0)
  expect(hidden.older ?? []).toHaveLength(0)
  expect(hidden.overview.waiting).toBe(0)
  expect(hidden.stoppedAsking ?? 0).toBe(0)
})

test('a copy cut off in the middle of a write neither makes a card vanish nor changes its age', () => {
  const text = block('aaaa1111', 'codex', 'demo', QUESTION)
  const second = text + block('bbbb2222', 'codex', 'demo', QUESTION)
  const ledger = ledgerOf([{ text, at: START }])
  const view = viewOf(text, ledger)
  const scope = JSON.stringify(['demo', 'codex', 'bbbb2222'])
  const mid = buildView(parseProgress(second), [], null, NOW, 0, {}, EN, [], {}, ledger, undefined, [], new Set([scope]))
  // The copy being written has no record yet, so it shows as it did before and merges once it is
  // recorded; the card of the recorded copy keeps its key and its age.
  const kept = mid.waiting.filter(item => item.questionId !== undefined)
  expect(kept).toHaveLength(1)
  expect(kept[0]?.when).toBe(view.waiting[0]?.when)
  expect(kept[0]?.key).toBe(view.waiting[0]?.key)
  expect(mid.waiting.filter(item => item.questionId === undefined)).toHaveLength(1)
  const whole = viewOf(second, ledgerOf([{ text, at: START }, { text: second, at: START + HOUR }]))
  // Once recorded it is the newer ask, and the one card shows that ask's time.
  expect(whole.waiting).toHaveLength(1)
  expect(whole.waiting[0]?.when).toBe(relativeTime(START + HOUR, NOW, EN))
})

test("a question stays on the board when another session's copy of it is renewed", () => {
  const first = block('aaaa1111', 'codex', 'demo', QUESTION)
  const owner = 'a'.repeat(64)
  const asked = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:1 -->`)
  const renewed = asked.replace(`question=${owner}:1`, `question=${owner}:2`)
  const ledger = ledgerOf([{ text: first, at: START }, { text: asked, at: START + HOUR }, { text: renewed, at: START + 2 * HOUR }])
  // The second session's first ask was replaced by its renewal; nobody answered or hid it.
  expect(ledger.records.filter(record => record.isUnresolved === false)).toHaveLength(1)
  const view = viewOf(renewed, ledger)
  // The question is one card, with the time of the renewal, the ask a reply goes to.
  expect(view.waiting).toHaveLength(1)
  expect(view.waiting[0]?.when).toBe(relativeTime(START + 2 * HOUR, NOW, EN))
  // The first session's copy is not covered, so Hide on the card closes both sessions' copies.
  const hidden = viewOf(renewed, ledger, [], [view.waiting[0]!.hideKey])
  expect(hidden.waiting).toHaveLength(0)
  expect(hidden.overview.waiting).toBe(0)
})

test('a question another session finished stays closed when that session goes on to ask something else', () => {
  const first = block('aaaa1111', 'codex', 'demo', QUESTION)
  const owner = 'b'.repeat(64)
  const asked = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:1 -->`)
  const next = 'Pick a name or a date?'
  const moved = first + block('bbbb2222', 'codex', 'demo', `${next}
<!-- question=${owner}:2 -->`)
  const ledger = ledgerOf([{ text: first, at: START }, { text: asked, at: START + HOUR }, { text: moved, at: START + 2 * HOUR }])
  // The second session asked the question after the first, then went on to another one: that is not
  // a renewal, so the first session's older copy stays covered and only the new question shows.
  expect(viewOf(moved, ledger).waiting.map(item => item.text)).toEqual([next])
})

test('a question asked again after a different one does not bring back a copy it covered', () => {
  const first = block('aaaa1111', 'codex', 'demo', QUESTION)
  const owner = 'b'.repeat(64)
  const asked = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:1 -->`)
  const next = 'Pick a name or a date?'
  const moved = first + block('bbbb2222', 'codex', 'demo', `${next}
<!-- question=${owner}:2 -->`)
  const again = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:3 -->`)
  const ledger = ledgerOf([{ text: first, at: START }, { text: asked, at: START + HOUR }, { text: moved, at: START + 2 * HOUR }, { text: again, at: START + 2.5 * HOUR }])
  const view = viewOf(again, ledger)
  // The first session's copy was covered before the second session asked again.
  expect(view.waiting.map(item => item.key)).toEqual([expect.stringContaining('Task bbbb2222')])
  expect(view.waiting[0]?.when).toBe(relativeTime(START + 2.5 * HOUR, NOW, EN))
})

test('a question asked again after a different one stays closed when recovered records come back out of order', () => {
  const first = block('aaaa1111', 'codex', 'demo', QUESTION)
  const owner = 'b'.repeat(64)
  const asked = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:1 -->`)
  const moved = first + block('bbbb2222', 'codex', 'demo', `Pick a name or a date?
<!-- question=${owner}:2 -->`)
  const again = first + block('bbbb2222', 'codex', 'demo', `${QUESTION}
<!-- question=${owner}:3 -->`)
  const ledger = ledgerOf([{ text: first, at: START }, { text: asked, at: START + HOUR }, { text: moved, at: START + 2 * HOUR }, { text: again, at: START + 2.5 * HOUR }])
  // Capture filenames can restore Q1, Q3, R2 even though the owner asked Q1, R2, Q3.
  const recovered = withCaptures(emptyQuestions(), [0, 1, 3, 2].map(index => {
    const record = ledger.records[index]!
    return { version: 1, disposition: record.isUnresolved ? 'unresolved' : 'resolved', record }
  }))
  expect(recovered.records.map(record => record.firstObserved)).toEqual([START, START + HOUR, START + 2.5 * HOUR, START + 2 * HOUR])
  const view = viewOf(again, recovered)
  expect(view.waiting.map(item => item.key)).toEqual([expect.stringContaining('Task bbbb2222')])
  expect(view.waiting[0]?.when).toBe(relativeTime(START + 2.5 * HOUR, NOW, EN))
})

test('a Hide pressed on an older question is refused once another copy of it has arrived', () => {
  const long = START - 10 * 24 * HOUR
  const live = block('aaaa1111', 'codex', 'demo', QUESTION)
  const before = viewOf(live, ledgerOf([{ text: live, at: long }]))
  expect(before.older).toHaveLength(1)
  const drawn = olderKey(before.older![0]!)
  const text = live + ended('bbbb2222', QUESTION, long)
  const after = viewOf(text, ledgerOf([{ text: live, at: long }, { text, at: START }]))
  // The card is still the live copy, but a Hide on it now closes the copy that arrived, which the
  // person never saw: the press made on the earlier drawing finds no line.
  expect(after.older).toHaveLength(1)
  expect(after.older![0]!.key).toBe(before.older![0]!.key)
  expect(boardItems(after, [], true, true).some(item => item.key === drawn)).toBe(false)
  expect(boardItems(before, [], true, true).some(item => item.key === drawn)).toBe(true)
})

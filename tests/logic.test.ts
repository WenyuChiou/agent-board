import { emptyQuestions, observeQuestions } from '../hooks/questions'
import { expect, test } from 'claude-code/testing'

import type { ProgressMirror } from '../types'
import { extractAutoBlock, removeAutoBlock, renderAutoBlock, scanBlocks, setManualStep, takeArchivable, upsertAutoBlock } from '../hooks/blocks'
import { ZH_TW } from '../hooks/i18n'
import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  cleanTitle,
  emptyMirror,
  fromTaskList,
  isStaleStoreKey,
  resumeNote,
  stateOf,
} from '../hooks/mirror'
import { parseProgress } from '../hooks/parse'
import { answeredJson, answeredPath, buildView, dueDays, foldSteps, IDLE_MS, keptAnswered, parseAnswered, parseSeen, relativeTime, seenJson, seenPath, taskFingerprint, withAnswered, withSeen } from '../hooks/view'

const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

const sampleMirror = (): ProgressMirror => {
  let mirror = emptyMirror('2be48af2-6193-5040', 'persona_framework', NOW)
  mirror = applyTaskCreate(mirror, { subject: '讀 API' }, '1', NOW)
  mirror = applyTaskCreate(mirror, { subject: '寫 Mod', activeForm: '寫 Mod 中' }, '2', NOW)
  mirror = applyTaskCreate(mirror, { subject: '推分支' }, '3', NOW)
  mirror = applyTaskUpdate(mirror, { taskId: '1', status: 'completed' }, NOW)
  mirror = applyTaskUpdate(mirror, { taskId: '2', status: 'in_progress' }, NOW)

  return { ...mirror, title: '進度面板', state: 'working' }
}

test('TaskCreate, TaskUpdate and metadata build the mirror', () => {
  let mirror = sampleMirror()
  expect(mirror.tasks.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])

  mirror = applyTaskUpdate(mirror, { taskId: '3', metadata: { waiting: 'you' } }, NOW)
  expect(mirror.tasks[2]?.waiting).toBe('you')
  mirror = applyTaskUpdate(mirror, { taskId: '3', metadata: { waiting: null, blocked: '缺金鑰' } }, NOW)
  expect(mirror.tasks[2]?.waiting).toBe(null)
  expect(mirror.tasks[2]?.blocked).toBe('缺金鑰')
  // Finishing a step clears what it waited on.
  mirror = applyTaskUpdate(mirror, { taskId: '3', status: 'completed' }, NOW)
  expect(mirror.tasks[2]?.blocked).toBe(null)

  mirror = applyTaskUpdate(mirror, { taskId: '2', status: 'deleted' }, NOW)
  expect(mirror.tasks.map(t => t.id)).toEqual(['1', '3'])
  expect(stateOf(mirror, true)).toBe('done')
})

test('background work uses the existing twelve hour stale rule and outlives a completed Task list', () => {
  const mirror = { ...sampleMirror(), backgroundJobs: 1 }
  expect(stateOf(mirror, false)).toBe('working')
  const file = upsertAutoBlock('', { ...mirror, state: stateOf(mirror, false) })
  expect(buildView(parseProgress(file), [], null, NOW + 12 * HOUR).stopped).toEqual([])
  expect(buildView(parseProgress(file), [], null, NOW + 12 * HOUR + 1).stopped.map(row => row.title)).toEqual(['進度面板'])
  const completed = { ...mirror, tasks: mirror.tasks.map(task => ({ ...task, status: 'completed' as const })) }
  expect(stateOf(completed, false)).toBe('working')
  expect(buildView([], [], completed, NOW).current?.status).toBe(ZH_TW.backgroundRunning)
  expect(buildView([], [], { ...completed, isTurnRunning: true }, NOW).current?.status).toBe(ZH_TW.claudeWorking)
  const asking = applyTaskUpdate(mirror, { taskId: '2', metadata: { waiting: 'you', why: 'Review it?' } }, NOW)
  expect(stateOf(asking, false)).toBe('waiting')
  expect(stateOf(asking, true)).toBe('working')
  expect(stateOf({ ...completed, backgroundJobs: 0 }, false)).toBe('done')
})

test('TodoWrite replaces the list; TaskList keeps what the mirror knew', () => {
  const mirror = applyTodoWrite(sampleMirror(), [{ content: '一', status: 'pending', activeForm: '做一' }], NOW)
  expect(mirror.tasks).toHaveLength(1)

  const known = applyTaskUpdate(sampleMirror(), { taskId: '3', metadata: { waiting: 'run' } }, NOW)
  const synced = fromTaskList(
    known,
    [
      { id: '3', subject: '推分支', status: 'pending', blockedBy: [] },
      { id: '4', subject: '回報', status: 'pending', blockedBy: ['3'] },
    ],
    NOW,
  )
  expect(synced.tasks.map(t => [t.id, t.waiting])).toEqual([
    ['3', 'run'],
    ['4', null],
  ])
})

test('the block lands under its project, is replaced in place, and comes out cleanly', () => {
  const manual = '# 專案進度\n\n## 求職\n### Google\n- [ ] 投遞\n\n## persona_framework\n### 手寫的\n- [ ] 一\n'
  const once = upsertAutoBlock(manual, sampleMirror())
  expect(once.startsWith(manual.replace(/\n$/, ''))).toBe(true)
  expect(once).toContain('<!-- auto session=2be48af2 agent=claude state=working')
  expect(once).toContain('- [~] 寫 Mod')

  const twice = upsertAutoBlock(once, { ...sampleMirror(), state: 'waiting' })
  expect(twice.match(/<!-- auto session=2be48af2/g)).toHaveLength(1)
  expect(twice).toContain('> 等你回覆')

  expect(removeAutoBlock(twice, '2be48af2-6193-5040')).toBe(manual)

  const fresh = upsertAutoBlock('', sampleMirror())
  expect(fresh.startsWith('# 專案進度\n\n## persona_framework\n\n<!-- auto')).toBe(true)
  expect(removeAutoBlock(fresh, '2be48af2-6193-5040')).toBe('# 專案進度\n')
})

test('Windows line endings survive a rewrite, and the parser reads the block back', () => {
  const crlf = '# 專案進度\r\n\r\n## 求職\r\n- [ ] 投遞\r\n'
  const out = upsertAutoBlock(crlf, sampleMirror())
  expect(out.includes('\r\n')).toBe(true)
  expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false)
  expect(extractAutoBlock(out, '2be48af2-6193-5040')).toContain('### 進度面板')

  const task = parseProgress(out).find(p => p.name === 'persona_framework')?.tasks[0]
  expect(task?.auto?.state).toBe('working')
  expect(task?.steps.map(s => s.status)).toEqual(['done', 'doing', 'todo'])
})

test('done blocks leave after half a day, open ones stay', () => {
  const old = { ...sampleMirror(), sessionId: 'aaaaaaaa-old', state: 'done' as const, updated: NOW - 13 * HOUR }
  const open = { ...sampleMirror(), sessionId: 'bbbbbbbb-open', state: 'waiting' as const, updated: NOW - 13 * HOUR }
  const text = upsertAutoBlock(upsertAutoBlock('', old), open)
  const { text: kept, entries } = takeArchivable(text, NOW)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toContain('## persona_framework · 2026-10-15')
  expect(entries[0]).not.toContain('<!--')
  expect(kept).toContain('session=bbbbbbbb')
  expect(kept).not.toContain('session=aaaaaaaa')
})

test('asked to tidy, a block done a minute ago goes now, while a stopped one still gets its three days', () => {
  const done = { ...sampleMirror(), sessionId: 'aaaaaaaa-new', state: 'done' as const, updated: NOW - 60 * 1000 }
  const ended = { ...sampleMirror(), sessionId: 'cccccccc-end', state: 'ended' as const, updated: NOW - HOUR }
  const text = upsertAutoBlock(upsertAutoBlock('', done), ended)
  expect(takeArchivable(text, NOW).entries).toHaveLength(0)
  const { text: kept, entries } = takeArchivable(text, NOW, undefined, undefined, true)
  expect(entries).toHaveLength(1)
  expect(kept).not.toContain('session=aaaaaaaa')
  expect(kept).toContain('session=cccccccc')
})

test('after a compaction the note says where things stand', () => {
  const note = resumeNote(sampleMirror()) ?? ''
  expect(note).toContain('目標：進度面板（persona_framework）')
  expect(note).toContain('完成 1/3')
  expect(note).toContain('正在做：寫 Mod')
  expect(note).toContain('接下來：推分支')
  const finished = applyTaskUpdate(
    applyTaskUpdate(sampleMirror(), { taskId: '2', status: 'completed' }, NOW),
    { taskId: '3', status: 'completed' },
    NOW,
  )
  expect(resumeNote(finished)).toBe(null)
})

test('plain words for time, dates and titles', () => {
  expect(relativeTime(NOW - 20 * 1000, NOW)).toBe('剛剛')
  expect(relativeTime(NOW - 5 * 60 * 1000, NOW)).toBe('5 分鐘前')
  expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3 小時前')
  expect(relativeTime(NOW - 30 * HOUR, NOW)).toBe('昨天')
  expect(dueDays('10-31', NOW)).toBe(15)
  expect(dueDays('2026-10-14', NOW)).toBe(-2)
  expect(dueDays('01-05', NOW)).toBe(81)
  expect(cleanTitle('「重做進度面板」。\n')).toBe('重做進度面板')
  expect(cleanTitle('任務名稱：求職追蹤')).toBe('求職追蹤')
})

test('the view sorts work into this session, waiting on you, due soon, other and done', () => {
  const others = `# 專案進度

## persona_framework
<!-- auto session=cccccccc state=waiting updated=2026-10-16T11:00:00.000Z -->
### 修 CI
- [x] 看 log
- [ ] 修
<!-- /auto session=cccccccc -->

## 求職
### Google 暑期實習
> 截止 10-18
- [x] 改履歷
- [?] 推薦信 — 等教授回覆
- [ ] 投遞

## FLOODABM
<!-- auto session=dddddddd state=ended updated=2026-10-15T10:00:00.000Z -->
### SFHA benchmark
- [x] 準備資料
- [ ] 跑 100 次
<!-- /auto session=dddddddd -->

## ai-research-skills
<!-- auto session=eeeeeeee state=done updated=2026-10-16T09:00:00.000Z -->
### 發佈 1.7.3
- [x] 打 tag
<!-- /auto session=eeeeeeee -->
`
  const view = buildView(parseProgress(others), ['persona_framework'], sampleMirror(), NOW)
  expect(view.current?.title).toBe('進度面板')
  expect(view.current?.status).toBe('正在做：寫 Mod 中')
  // 修 CI's turn ended without asking anything: it is work in progress, not waiting on you.
  expect(view.waiting.map(w => [w.task, w.text, w.note])).toEqual([['Google 暑期實習', '推薦信', '等教授回覆']])
  expect(view.due.map(d => [d.title, d.due?.left, d.due?.tone, d.status])).toEqual([
    ['Google 暑期實習', '還有 2 天', 'alert', '等你：推薦信'],
  ])
  // Listed under 快到期, so not again under 其他進行中.
  expect(view.active.map(a => [a.project, a.status])).toEqual([
    ['persona_framework', '下一步：修'],
  ])
  expect(view.stopped.map(row => [row.project, row.status])).toEqual([['FLOODABM', '對話已結束，可接手']])
  expect(view.recent.map(r => r.title)).toEqual(['發佈 1.7.3'])
})

test('a turn that ends with no question, or waits only on CI, is not listed as waiting on the person', () => {
  const block = (id: string, agent: string, title: string, steps: string, extra = ''): string =>
    `<!-- auto session=${id} agent=${agent} state=waiting updated=2026-10-16T11:00:00.000Z${extra} -->\n### ${title}\n${steps}<!-- /auto session=${id} -->\n`
  const file = [
    '# 專案進度\n\n## api-gateway\n',
    block('a1a1a1a1', 'claude', '修 CI', '- [x] 看 log\n- [ ] 修\n'),
    block('b2b2b2b2', 'codex', '合併 #350', '- [x] 修好\n- [>] 等 CI 跑完\n'),
    block('c3c3c3c3', 'codex', '對照 2007 到 2009', '- [x] 讀資料\n- [~] 比對\n'),
    // Two sessions on one pull request: the older one finished, the newer one asks.
    block('d4d4d4d4', 'claude', '量測 T10', '- [x] 跑完\n- [ ] 寫報告\n', ' pr=402'),
    block('e5e5e5e5', 'claude', '重評 T1', '- [x] 重評\n- [?] 新基準 — 接受這 11 張卡當新基準，OK?\n', ' pr=402'),
    // With a date close by, such a block is listed under 快到期 like any other open work.
    block('f6f6f6f6', 'codex', '交報告', '> 截止 10-18\n- [ ] 寫結論\n'),
  ].join('\n')
  const view = buildView(parseProgress(file), ['elsewhere'], null, NOW)
  expect(view.waiting.map(w => [w.task, w.text])).toEqual([['重評 T1', '新基準']])
  expect(view.active.map(a => [a.title, a.status])).toEqual([
    ['修 CI', '下一步：修'],
    ['合併 #350', '在跑：等 CI 跑完'],
    ['對照 2007 到 2009', '正在做：比對'],
    ['量測 T10', '下一步：寫報告'],
  ])
  expect(view.due.map(d => [d.title, d.status])).toEqual([['交報告', '下一步：寫結論']])
  expect(view.overview.waiting).toBe(1)
})

test('long lists fold finished steps and the far end', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    text: `步驟 ${i + 1}`,
    note: '',
    status: i < 4 ? ('done' as const) : ('todo' as const),
    depth: 0,
    isCurrent: i === 4,
    number: i + 1,
  }))
  expect(foldSteps(steps).map(s => s.text)).toEqual([
    '已完成 4 步',
    '步驟 5',
    '步驟 6',
    '步驟 7',
    '步驟 8',
    '步驟 9',
    '步驟 10',
    '還有 2 步',
  ])
})

const stepsOf = (text: string, project: string, title: string, index = 0) =>
  parseProgress(text)
    .find(p => p.name === project)
    ?.tasks.filter(t => t.title === title)[index]?.steps ?? []

const refOf = (text: string, project: string, title: string, step: string, index = 0) => {
  const found = stepsOf(text, project, title, index).find(s => s.text === step)
  if (found === undefined) throw new Error(`no step ${step}`)
  return { project, title, step, line: found.line, raw: found.raw }
}

test('a press ticks the exact line it showed, and nothing once that line changed', () => {
  const text = '## 求職\n### Google\n- [-] 投遞\n- [ ] 投遞\n\n### 週報\n- [ ] 寫\n\n### 週報\n- [ ] 寫\n'
  // The open 投遞 is ticked, not the cancelled one above it.
  const open = stepsOf(text, '求職', 'Google')[1]
  expect(open?.status).toBe('todo')
  const ticked = setManualStep(text, { project: '求職', title: 'Google', step: '投遞', line: open?.line ?? -1, raw: open?.raw ?? '' }, 'x')
  expect(ticked).toBe('## 求職\n### Google\n- [-] 投遞\n- [x] 投遞\n\n### 週報\n- [ ] 寫\n\n### 週報\n- [ ] 寫\n')

  // Two tasks with one title: each row has its own key, and a press ticks its own task.
  const keys = buildView(parseProgress(text), [], null, NOW).active.map(r => r.key)
  expect(keys).toEqual(['求職::Google', '求職::週報', '求職::週報#2'])
  const second = refOf(text, '求職', '週報', '寫', 1)
  expect(setManualStep(text, second, 'x').endsWith('### 週報\n- [x] 寫\n')).toBe(true)
  expect(setManualStep(text, second, 'x')).toContain('### 週報\n- [ ] 寫\n\n### 週報')

  // Another session set the step to [!] since the pane last read the file: left alone.
  const changed = text.replace('- [ ] 投遞', '- [!] 投遞')
  const stale = { project: '求職', title: 'Google', step: '投遞', line: open?.line ?? -1, raw: open?.raw ?? '' }
  expect(setManualStep(changed, stale, 'x')).toBe(changed)
})

test('a press still finds its step after lines above it moved, unless the step has a twin', () => {
  const text = '## 求職\n### Google\n- [ ] 改履歷\n- [ ] 投遞\n'
  const ref = refOf(text, '求職', 'Google', '投遞')
  const moved = '# 專案進度\n\n## 新專案\n- [ ] 別的\n\n' + text
  expect(setManualStep(moved, ref, 'x')).toBe(moved.replace('- [ ] 投遞', '- [x] 投遞'))

  const twin = moved + '\n## 求職 2\n### Google\n- [ ] 投遞\n'
  expect(setManualStep(twin, ref, 'x')).toBe(twin)
})

test('archive moves a closed block whole and leaves an unclosed one where it is', () => {
  const day = (h: number) => new Date(NOW - h * HOUR).toISOString()
  const text = [
    '## alpha',
    `<!-- auto session=aaaaaaaa state=done updated=${day(20)} -->`,
    '### 收尾',
    '> 完成',
    '- [x] 一',
    '- [x] 最後一步',
    '<!-- /auto session=aaaaaaaa -->',
    '',
    '## beta',
    `<!-- auto session=bbbbbbbb state=done updated=${day(20)} -->`,
    '### 沒有結尾標記',
    '- [x] 一',
    '',
    '### 手寫的',
    '- [ ] 別刪我',
    '',
  ].join('\n')
  const { text: kept, entries } = takeArchivable(text, NOW)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toBe('## alpha · 2026-10-15\n### 收尾\n> 完成\n- [x] 一\n- [x] 最後一步')
  expect(kept).toContain('session=bbbbbbbb')
  expect(kept).toContain('### 手寫的\n- [ ] 別刪我')
  expect(kept).not.toContain('session=aaaaaaaa')
})

test('an end marker closes only its own block, and an unclosed block stops before hand-kept tasks', () => {
  const lines = [
    '## alpha',
    '<!-- auto session=aaaaaaaa state=working updated=2026-10-16T10:00:00.000Z -->',
    '### 我的',
    '- [ ] 一',
    '<!-- /auto session=zzzzzzzz -->',
    '- [ ] 二',
    '',
    '### 手寫的',
    '- [ ] 別蓋掉我',
  ]
  const [span] = scanBlocks(lines)
  expect(span?.isClosed).toBe(false)
  expect(span?.end).toBe(3)

  const mirror = { ...sampleMirror(), sessionId: 'aaaaaaaa-1', project: 'alpha' }
  const out = upsertAutoBlock(lines.join('\n') + '\n', mirror)
  expect(out).toContain('### 手寫的\n- [ ] 別蓋掉我')
  expect(out.match(/session=aaaaaaaa agent=claude state=/g)).toHaveLength(1)
})

test("the person's own store settings are never aged out", () => {
  const month = 31 * 24 * HOUR
  expect(isStaleStoreKey('closedByPerson', true, NOW, 30 * 24 * HOUR)).toBe(false)
  expect(isStaleStoreKey('mirror:abc', { updated: NOW - month }, NOW, 30 * 24 * HOUR)).toBe(true)
  expect(isStaleStoreKey('mirror:abc', { updated: NOW - HOUR }, NOW, 30 * 24 * HOUR)).toBe(false)
  expect(isStaleStoreKey('hinted:abc', NOW - month, NOW, 30 * 24 * HOUR)).toBe(true)
  expect(isStaleStoreKey('completion:abc', { updated: NOW - month }, NOW, 30 * 24 * HOUR)).toBe(false)
})

test('a task row keeps every open step for the take-over prompt, past the fold', () => {
  const steps = Array.from({ length: 9 }, (_, i) => `- [${i < 2 ? 'x' : ' '}] 步驟 ${i + 1}`).join('\n')
  const text = `## FLOODABM\n<!-- auto session=dddddddd state=ended updated=2026-10-16T10:00:00.000Z -->\n### 跑實驗\n${steps}\n<!-- /auto session=dddddddd -->\n`
  const [row] = buildView(parseProgress(text), ['FLOODABM'], null, NOW).stopped
  expect(row?.steps.some(s => s.text.startsWith('還有'))).toBe(true)
  expect(row?.left).toEqual(['步驟 3', '步驟 4', '步驟 5', '步驟 6', '步驟 7', '步驟 8', '步驟 9'])
})

test('a question marked answered leaves Waiting on you until that session asks something new', () => {
  const mirror = applyTaskUpdate(sampleMirror(), { taskId: '3', metadata: { waiting: 'you', why: '可以推上 main 嗎？' } }, NOW)
  // This session's own question, and the same step as its block shows it to every other session.
  const own = buildView([], [], mirror, NOW).waiting[0]
  const file = ['# 專案進度', '', '## persona_framework', ...renderAutoBlock(mirror), ''].join('\n')
  const seen = buildView(parseProgress(file), [], null, NOW).waiting[0]
  expect(own?.where).toBe('here')
  expect(seen?.where).toBe('other')
  const key = own?.hideKey ?? ''
  // The session, the step's place in its block (task 3 is the third step) and its words.
  expect(key).toBe('2be48af2 3 推分支 — 可以推上 main 嗎？')
  expect(seen?.hideKey).toBe(key)

  // Marked answered: out of the list, its count and the focus, and listed as hidden instead.
  const view = buildView(parseProgress(file), [], null, NOW, 0, {}, ZH_TW, [key])
  expect(view.waiting).toEqual([])
  expect(view.overview.waiting).toBe(0)
  expect(view.focus?.type).not.toBe('ask')
  expect(view.hidden.map(item => item.text)).toEqual(['推分支'])
  expect(buildView([], [], mirror, NOW, 0, {}, ZH_TW, [key]).hidden.map(item => item.where)).toEqual(['here'])

  // The session words it anew: a new question, shown again.
  const asked = file.replace('推分支 — 可以推上 main 嗎？', '推分支 — 推到 release 分支好嗎？')
  expect(asked).not.toBe(file)
  expect(buildView(parseProgress(asked), [], null, NOW, 0, {}, ZH_TW, [key]).waiting.map(item => item.text)).toEqual(['推分支'])
  // A hand-kept step is ticked, never hidden.
  const manual = ['# 專案進度', '', '## 求職', '### 實習', '- [?] 推薦信', ''].join('\n')
  expect(buildView(parseProgress(manual), [], null, NOW, 0, {}, ZH_TW, ['']).waiting[0]?.hideKey).toBe('')

  // A press changes only the questions pressed, whatever the view it came from showed.
  const projects = parseProgress(file)
  expect(withAnswered(['2be48af2 3 舊的問題', 'ffffffff 1 別的對話', key], ['new'], true)).toEqual(['2be48af2 3 舊的問題', 'ffffffff 1 別的對話', key, 'new'])
  expect(withAnswered([key], [key], false)).toEqual([])
  // A mark whose question left its session's block goes, so the same words asked later show;
  // a session with no block in the file yet keeps its marks.
  expect(keptAnswered(['2be48af2 3 舊的問題', 'ffffffff 1 別的對話', key], projects)).toEqual(['ffffffff 1 別的對話', key])
  expect(keptAnswered([key], parseProgress(asked))).toEqual([])
  expect(keptAnswered([key], [])).toEqual([key])
  // A file just caught half-way reads as null, to be read again rather than written over; one
  // that has stayed broken reads as none, so the next press writes it anew.
  expect(parseAnswered(answeredJson([key]))).toEqual([key])
  expect(parseAnswered('{"answered": [1, "a", ""]}')).toEqual(['a'])
  expect(parseAnswered('')).toEqual([])
  expect(parseAnswered('{"answered": ["a"')).toBeNull()
  expect(parseAnswered('{"answered": ["a"', 4000)).toBeNull()
  expect(parseAnswered('{"answered": ["a"', 6000)).toEqual([])
  expect(parseAnswered('{"answered": ["a"', -60000)).toEqual([])
  expect(answeredPath('/home/me/.claude/progress.md')).toBe('/home/me/.claude/progress-answered.json')
})

test('this session and every other reader key a question the same way, whatever its words, and two alike stay apart', () => {
  // Words the block writer changes on the way in: heading marks, no subject, the note mark itself.
  const subjects = [['# # A', 'x'], ['', '只有說明'], ['先試 — 再說', '好嗎？'], ['推分支', ''], ['a <!-- b --> c', 'd\ne']]
  for (const [subject, why] of subjects) {
    const mirror = applyTaskUpdate(sampleMirror(), { taskId: '3', subject, metadata: { waiting: 'you', why } }, NOW)
    const file = ['# 專案進度', '', '## persona_framework', ...renderAutoBlock(mirror), ''].join('\n')
    const own = buildView([], [], mirror, NOW).waiting[0]?.hideKey
    expect(own).not.toBe('')
    expect(buildView(parseProgress(file), [], null, NOW).waiting[0]?.hideKey).toBe(own)
  }
  // A blocked step is written [!]: no other reader lists it as a question, so it is not marked.
  const stuck = applyTaskUpdate(sampleMirror(), { taskId: '3', metadata: { waiting: 'you', why: '要你決定', blocked: '等 CI' } }, NOW)
  expect(buildView([], [], stuck, NOW).waiting.map(item => item.hideKey)).toEqual([''])
  // Two steps with the same words: marking one leaves the other.
  const at = new Date(NOW - HOUR).toISOString()
  const twice = ['## api', `<!-- auto session=c0ffee12 agent=codex state=waiting updated=${at} -->`, '### Ship', '- [?] Merge it, OK?', '- [x] Tests', '- [?] Merge it, OK?', '<!-- /auto session=c0ffee12 -->', ''].join('\n')
  const keys = buildView(parseProgress(twice), [], null, NOW).waiting.map(item => item.hideKey)
  expect(keys).toEqual(['c0ffee12 1 Merge it, OK?', 'c0ffee12 3 Merge it, OK?'])
  expect(buildView(parseProgress(twice), [], null, NOW, 0, {}, ZH_TW, [keys[0] ?? '']).waiting.map(item => item.hideKey)).toEqual([keys[1]])
  // The first is then ticked: the third keeps its own key, so it neither takes the first one's
  // mark nor loses its own.
  const ticked = parseProgress(twice.replace('- [?] Merge it, OK?', '- [x] Merge it, OK?'))
  expect(buildView(ticked, [], null, NOW, 0, {}, ZH_TW, [keys[0] ?? '']).waiting.map(item => item.hideKey)).toEqual([keys[1]])
  expect(buildView(ticked, [], null, NOW, 0, {}, ZH_TW, [keys[1] ?? '']).waiting).toEqual([])
})

test('a question from every agent that writes a block can be marked answered', () => {
  const agents = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'muse', 'hermes', 'openclaw', 'opencode', 'aider']
  const at = new Date(NOW - HOUR).toISOString()
  const blocks = agents.flatMap((agent, index) => {
    const id = `a${String(index).padStart(7, '0')}`
    return [`<!-- auto session=${id} agent=${agent} state=waiting updated=${at} -->`, `### ${agent} work`, '- [?] Ship it, OK?', `<!-- /auto session=${id} -->`]
  })
  const file = ['# Progress', '', '## api', ...blocks, ''].join('\n')
  const view = buildView(parseProgress(file), [], null, NOW)
  expect(view.waiting.map(item => item.agent || 'claude').sort()).toEqual([...agents].sort())
  const keys = view.waiting.map(item => item.hideKey)
  expect(keys.every(key => key !== '')).toBe(true)
  const hidden = buildView(parseProgress(file), [], null, NOW, 0, {}, ZH_TW, keys)
  expect(hidden.waiting).toEqual([])
  expect(hidden.hidden.map(item => item.agent || 'claude').sort()).toEqual([...agents].sort())
})


test("an ended or stale session's task moves to the Stopped shelf and leaves the In progress count", () => {
  const block = (id: string, title: string, state: string, age: number, extra = '', steps = '- [ ] Finish'): string =>
    `<!-- auto session=${id} state=${state} updated=${new Date(NOW - age).toISOString()} -->\n### ${title}\n${extra}${steps}\n<!-- /auto session=${id} -->`
  const file = ['## demo',
    block('11111111', 'Earlier ended', 'ended', 2 * HOUR),
    block('22222222', 'Fresh ended', 'ended', HOUR),
    block('33333333', 'Stale working', 'working', 13 * HOUR),
    block('44444444', 'Due soon', 'ended', 13 * HOUR, '> due 2026-10-30\n'),
    block('55555555', 'Idle ended', 'ended', 8 * 24 * HOUR),
    block('66666666', 'Running', 'working', HOUR),
    block('77777777', 'Finished', 'ended', HOUR, '', '- [x] Finished'),
  ].join('\n')
  const view = buildView(parseProgress(file), [], null, NOW)
  expect(view.stopped.map(row => row.title)).toEqual(['Fresh ended', 'Earlier ended', 'Stale working'])
  expect(view.stopped.every(row => row.auto === 'ended' && row.tone === 'warn' && row.confirm !== null && row.archive !== null)).toBe(true)
  expect(view.due.map(row => row.title)).toEqual(['Due soon'])
  expect(view.idle.map(row => row.title)).toEqual(['Idle ended'])
  expect(view.active.map(row => row.title)).toEqual(['Running'])
  expect(view.groups.flatMap(group => group.rows).map(row => row.title)).toEqual(['Running'])
  expect(view.overview.active).toBe(2)
  expect(view.overview.stopped).toBe(3)
  expect(view.recent.map(row => row.title)).toEqual(['Finished'])
})

test('a stopped task with a question shows once under Waiting on you and is not also counted as In progress', () => {
  const file = '## demo\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z resume=codex-session-123 dir=%2Fw -->\n### Release\n- [?] Publish, OK?\n- [ ] Finish\n<!-- /auto session=a1b2c3d4 -->'
  const view = buildView(parseProgress(file), [], null, NOW)
  expect(view.waiting.map(item => item.text)).toEqual(['Publish, OK?'])
  expect(view.overview.waiting).toBe(1)
  expect(view.overview.active).toBe(0)
  expect(view.active).toEqual([])
  expect(view.groups).toEqual([])
  expect(view.stopped[0]).toMatchObject({ question: 'Publish, OK?', resume: "cd '/w' && codex resume codex-session-123" })
  const hidden = buildView(parseProgress(file), [], null, NOW, 0, {}, ZH_TW, [view.waiting[0]?.hideKey ?? ''])
  expect(hidden.waiting).toEqual([])
  expect(hidden.hidden).toHaveLength(1)
  expect(hidden.stopped).toHaveLength(1)
})

test('a task idle exactly seven days stays on the board and one idle a millisecond longer is hidden', () => {
  const file = (at: number): string => `## demo
<!-- auto session=a1b2c3d4 state=ended updated=${new Date(at).toISOString()} -->
### Old work
- [ ] Finish
<!-- /auto session=a1b2c3d4 -->`
  const boundary = buildView(parseProgress(file(NOW - IDLE_MS)), [], null, NOW)
  expect(boundary.stopped).toHaveLength(1)
  expect(boundary.idle).toEqual([])
  const older = buildView(parseProgress(file(NOW - IDLE_MS - 1)), [], null, NOW)
  expect(older.active).toEqual([])
  expect(older.groups).toEqual([])
  expect(older.idle[0]?.when).toBe(relativeTime(NOW - IDLE_MS - 1, NOW))
  expect(older.overview.idle).toBe(1)
})

test('a hand-kept task is aged from when its content was first seen, and editing a step makes it fresh again', () => {
  const file = '## demo\n### Plan\n> Context: a note\n- [ ] Finish\n'
  const projects = parseProgress(file)
  const seen = withSeen({}, projects, NOW - IDLE_MS - 1)
  const view = (text: string) => buildView(parseProgress(text), [], null, NOW, 0, {}, ZH_TW, [], seen)
  expect(view(file).idle).toHaveLength(1)
  expect(view(file.replace('a note', 'another note').replace('- [ ] Finish', '  - [ ] Finish  ')).idle).toHaveLength(1)
  expect(view(file.replace('Finish', 'Finish carefully')).idle).toEqual([])
  expect(view(file.replace('[ ]', '[~]')).active).toHaveLength(1)
  expect(withSeen(seen, projects, NOW)).toEqual(seen)
  expect(Object.keys(seen)[0]).toMatch(/^[0-9a-f]{64}$/)
})

test('a hand-kept task the seen record does not know is never hidden', () => {
  const file = `## demo
### Unknown
- [ ] Finish
<!-- auto session=a1b2c3d4 state=waiting updated=invalid -->
### Undated block
- [?] Continue, OK?
<!-- /auto session=a1b2c3d4 -->`
  const projects = parseProgress(file)
  expect(buildView(projects, [], null, NOW).idle).toEqual([])
  expect(buildView(projects, [], null, NOW, 0, {}, ZH_TW, [], parseSeen('{', 6000) ?? {}).idle).toEqual([])
  const seen = withSeen({}, projects, NOW - IDLE_MS - 1)
  const aged = buildView(projects, [], null, NOW, 0, {}, ZH_TW, [], seen)
  expect(aged.idle.map(row => row.title)).toEqual(['Unknown', 'Undated block'])
  expect(aged.waiting.map(item => item.text)).toEqual(['Continue, OK?'])
})

test("an old unanswered question leaves actionable counts and remains recoverable independently of its idle task", () => {
  const projects = parseProgress('## demo\n### Question\n- [?] Publish, OK?\n')
  const seen = withSeen({}, projects, NOW - 9 * 24 * HOUR)
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW - 9 * 24 * HOUR, true, 'fixture:1').ledger
  const view = buildView(projects, [], null, NOW, 0, {}, ZH_TW, [], seen, ledger)
  expect(view.waiting).toEqual([])
  expect(view.hidden).toEqual([])
  expect(view.overview).toEqual({ waiting: 0, active: 0, due: 0, today: 0, idle: 1, stopped: 0 })
  expect(view.focus).toBe(null)
  expect(view.idle[0]?.question).toBe(null)
  expect(view.idle[0]?.when).toBe(relativeTime(NOW - 9 * 24 * HOUR, NOW))
  expect(view.idle[0]?.next).not.toBe(null)
  expect(view.idle[0]?.archive).not.toBe(null)
})

test("a task due within two weeks, this session's own block and a future timestamp are never hidden as idle", () => {
  const file = `## demo
### Due
> due 2026-10-30
- [?] Ship, OK?
### Late
> due 2026-10-15
- [ ] Finish
### Later
> due 2026-10-31
- [ ] Finish
### Completed
- [x] Finished
<!-- auto session=2be48af2 state=working updated=2026-09-01T12:00:00Z -->
### Mine
- [~] Work
<!-- /auto session=2be48af2 -->
<!-- auto session=a1b2c3d4 state=working updated=2026-11-01T12:00:00Z -->
### Future
- [~] Work
<!-- /auto session=a1b2c3d4 -->`
  const projects = parseProgress(file)
  const seen = withSeen({}, projects, NOW - IDLE_MS - 1)
  const view = buildView(projects, [], sampleMirror(), NOW, 0, {}, ZH_TW, [], seen)
  expect(view.idle.map(row => row.title)).toEqual(['Later'])
  expect(view.due.map(row => row.title)).toEqual(['Late', 'Due'])
  // A due task's question stays in Waiting on you, however long it has waited.
  expect(view.waiting.map(item => item.text)).toContain('Ship, OK?')
  expect(view.current).not.toBe(null)
  expect(view.active.map(row => row.title)).toEqual(['Future'])
  expect(view.recent.some(row => row.title === 'Completed')).toBe(true)
  const futureSeen = withSeen({}, parseProgress('## demo\n### Future manual\n- [ ] Finish'), NOW + 1)
  expect(buildView(parseProgress('## demo\n### Future manual\n- [ ] Finish'), [], null, NOW, 0, {}, ZH_TW, [], futureSeen).idle).toEqual([])
})

test('the seen record keeps the earliest time per task, drops tasks no longer in the file only once it has held still, and reads a broken file as empty', () => {
  const projects = parseProgress('## demo\n### Plan\n- [ ] Finish\n')
  const earlier = withSeen({}, projects, NOW - IDLE_MS - 1)
  const later = withSeen({}, projects, NOW)
  expect(withSeen(later, projects, NOW, earlier)).toEqual(earlier)
  expect(withSeen(earlier, projects, NOW, later)).toEqual(earlier)
  // One read of a file caught empty keeps every task's age; a file that held still drops them.
  expect(withSeen(earlier, [], NOW)).toEqual(earlier)
  expect(withSeen({}, [], NOW, earlier)).toEqual(earlier)
  expect(withSeen(earlier, [], NOW, {}, true)).toEqual({})
  const other = parseProgress('## demo\n### Other\n- [ ] Start\n')
  expect(Object.keys(withSeen(earlier, other, NOW))[0]).toBe(Object.keys(withSeen({}, other, NOW))[0])
  expect(parseSeen(seenJson(earlier))).toEqual(earlier)
  expect(parseSeen('{', 4999)).toBe(null)
  expect(parseSeen('{', -4999)).toBe(null)
  expect(parseSeen('{', 5000)).toEqual({})
  for (const text of ['', 'null', '[]', '{"seen":[]}', '{"seen":null}', '{"seen":5}']) expect(parseSeen(text)).toEqual({})
  const key = Object.keys(earlier)[0] ?? ''
  for (const value of ['0', '-1', '1e400', '"123"', 'null']) expect(parseSeen(`{"seen":{"${key}":${value}}}`)).toEqual({})
  const many = parseProgress('## demo\n' + Array.from({ length: 510 }, (_, i) => `### Task ${i}\n- [ ] Finish\n`).join(''))
  expect(Object.keys(withSeen({}, many, NOW))).toHaveLength(500)
  expect(Object.keys(parseSeen(seenJson(Object.fromEntries(many[0]?.tasks.map(task => [taskFingerprint('demo', task), NOW]) ?? []))) ?? {})).toHaveLength(500)
  expect(seenPath('/tmp/progress.md')).toBe('/tmp/progress-seen.json')
  expect(seenPath('/tmp/BOARD.MD')).toBe('/tmp/BOARD-seen.json')
})

import { emptyQuestions, observeQuestions } from '../hooks/questions'
import { expect, test } from 'claude-code/testing'

import type { ProgressMirror } from '../types'
import { archivableAsking, countManualDone, confirmTask, extractAutoBlock, removeAutoBlock, renderAutoBlock, scanBlocks, setManualStep, stateWords, takeArchivable, takeManualDone, takeTask, upsertAutoBlock } from '../hooks/blocks'
import { ZH_TW } from '../hooks/i18n'
import { STRINGS } from '../hooks/strings'
import { answerAgentPrompt } from '../hooks/inbox'
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
import { futureTimeKey, parseProgress, STALE_MS } from '../hooks/parse'
import { BIG_AT, bigBoard } from './fixtures/big-board'
import { answeredJson, answeredPath, buildView, dueDays, foldSteps, handKeptSeenAt, IDLE_MS, keptAnswered, parseAnswered, parseSeen, relativeTime, seenJson, seenPath, SWEEP_ARMED_KEY, taskFingerprint, withAnswered, withSeen } from '../hooks/view'

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

test('a Codex block set to working says Codex is working, not Claude', () => {
  const s = STRINGS.en
  const mirror = { ...sampleMirror(), agent: 'codex', state: 'waiting' as const, resume: 'codex-session-123', turnOrder: NOW * 2 }
  const old = upsertAutoBlock('', { ...mirror, state: 'working' }, s).replace('> Codex is working', '> Claude is working')
  const prompt = { agent: 'codex', event: 'prompt' as const, id: mirror.sessionId, session: mirror.resume, cwd: '', project: mirror.project, prompt: '', answer: '', transcript: '', at: NOW + 1000 }
  const next = answerAgentPrompt(mirror, prompt, NOW + 1000)!
  const before = `## Other\n### Leave this alone\n- [ ] Another task\n\n${old}`
  const after = upsertAutoBlock(before, next, s)
  expect(after).toContain('> Codex is working')
  expect(after).not.toContain('Claude is working')
  expect(removeAutoBlock(after, mirror.sessionId)).toBe(removeAutoBlock(before, mirror.sessionId))
  const task = parseProgress(after).find(project => project.name === mirror.project)?.tasks[0]
  expect(task?.auto?.agent).toBe('codex')
  expect(task?.auto?.state).toBe('working')
  expect(task?.steps.map(step => step.status)).toEqual(['done', 'doing', 'todo'])
})

test('every agent\'s working block names that agent', () => {
  const agents = { codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', grok: 'Grok Build', muse: 'Muse Code', dot: 'dot', hermes: 'Hermes Agent', openclaw: 'OpenClaw', opencode: 'OpenCode', antigravity: 'Antigravity', deepseek: 'DeepSeek', 'custom-agent': 'custom-agent', constructor: 'constructor' }
  for (const s of Object.values(STRINGS)) {
    for (const [agent, name] of Object.entries(agents)) {
      const block = renderAutoBlock({ ...sampleMirror(), agent }, s)
      expect(block[2]).toBe(`> ${s.agentWorking(name)}`)
      expect(block[2]).not.toContain('Claude')
      expect(stateWords('done', agent, s)).toBe(s.stateDone)
      expect(stateWords('ended', agent, s)).toBe(s.stateEnded)
    }
  }
})

test('a Claude block keeps its working and waiting words', () => {
  const working = { en: 'Claude is working', 'zh-TW': 'Claude 正在做', 'zh-CN': 'Claude 正在做' }
  const waiting = { en: 'Waiting for your next message', 'zh-TW': '等你回覆', 'zh-CN': '等你回复' }
  for (const s of Object.values(STRINGS)) {
    for (const agent of ['claude', '']) {
      expect(renderAutoBlock({ ...sampleMirror(), agent }, s)[2]).toBe(`> ${working[s.lang]}`)
      expect(renderAutoBlock({ ...sampleMirror(), agent, state: 'waiting' }, s)[2]).toBe(`> ${waiting[s.lang]}`)
    }
  }
})

test('the waiting line names no agent', () => {
  for (const s of Object.values(STRINGS)) {
    for (const agent of ['claude', ...Object.keys(s.agentNames), 'custom-agent']) {
      const block = renderAutoBlock({ ...sampleMirror(), agent, state: 'waiting' }, s)
      expect(block[2]).toBe(`> ${s.stateWaiting}`)
      for (const name of ['Claude', ...Object.values(s.agentNames), 'custom-agent']) expect(block[2]).not.toContain(name)
    }
  }
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

// Made-up blocks for the automatic archive of a block that still asks (#174).
const askingBlock = (session: string, state: string, hours: number, steps: string[]): string[] => [
  `<!-- auto session=${session} agent=codex state=${state} updated=${new Date(NOW - hours * HOUR).toISOString()} -->`,
  `### Plan ${session}`,
  '> Context: Synthetic data.',
  ...steps,
  `<!-- /auto session=${session} -->`,
  '',
]
const askingBoard = (): string => [
  '## alpha',
  ...askingBlock('aaaaaaaa', 'ended', 100, ['- [x] One', '- [?] Publish the plan, OK?']),
  ...askingBlock('bbbbbbbb', 'done', 100, ['- [x] One', '- [?] Pick 24 hours or 7 days?']),
  ...askingBlock('cccccccc', 'ended', 50, ['- [?] Still inside the grace, OK?']),
  ...askingBlock('dddddddd', 'ended', 100, ['- [x] One', '- [-] Dropped']),
  ...askingBlock('eeeeeeee', 'working', 100, ['- [~] Work', '- [?] Waiting on a stopped session, OK?']),
  ...askingBlock('ffffffff', 'waiting', 100, ['- [?] Waiting for an answer, OK?']),
].join('\n')

test('a block that asks is listed for the question check only once its three or seven quiet days are over', () => {
  const asking = archivableAsking(askingBoard(), NOW)
  // The ended and the done block; not the one 50 hours old, nor the one that asks nothing, nor a
  // working or waiting one inside their seven days.
  expect(asking.map(one => one.ref.session)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  expect(asking.map(one => [one.ref.project, one.ref.title])).toEqual([['alpha', 'Plan aaaaaaaa'], ['alpha', 'Plan bbbbbbbb']])
  // The session's own block is never listed.
  expect(archivableAsking(askingBoard(), NOW, 'aaaaaaaa').map(one => one.ref.session)).toEqual(['bbbbbbbb'])
})

test('a block that asks is taken only when the check says its questions are kept', () => {
  const text = askingBoard()
  // With no verdict only the block that asks nothing goes, as before.
  const none = takeArchivable(text, NOW, undefined, STRINGS.en)
  expect(none.entries).toHaveLength(1)
  expect(none.entries[0]).toContain('Plan dddddddd')
  // One verdict of yes takes that block with the quiet one, and leaves the rest.
  const one = takeArchivable(text, NOW, undefined, STRINGS.en, false, span => span.session === 'aaaaaaaa')
  expect(one.entries).toHaveLength(2)
  expect(one.text).not.toContain('session=aaaaaaaa')
  expect(one.text).toContain('session=bbbbbbbb')
  expect(one.text).toContain('session=eeeeeeee')
  // Even a yes for every block leaves the ended one inside its three days, and working or waiting ones inside their seven days.
  const all = takeArchivable(text, NOW, undefined, STRINGS.en, false, () => true)
  expect(all.entries).toHaveLength(3)
  expect(all.text).toContain('session=cccccccc')
  expect(all.text).toContain('session=eeeeeeee')
  expect(all.text).toContain('session=ffffffff')
  // Nor the session's own block.
  const own = takeArchivable(text, NOW, 'aaaaaaaa', STRINGS.en, false, () => true)
  expect(own.entries).toHaveLength(2)
  expect(own.text).toContain('session=aaaaaaaa')
})

test('a working or waiting block that asks is taken after seven days without a report, and an ended or done one after three', () => {
  for (const state of ['working', 'waiting']) for (const hours of [100, 144, 167, 168, 169, 24 * 40]) {
    const text = ['## alpha', ...askingBlock('jjjjjjjj', state, hours, ['- [?] Pick 24 hours or 7 days?'])].join('\n')
    const isDue = hours > 168
    expect(archivableAsking(text, NOW).map(one => one.ref.session)).toEqual(isDue ? ['jjjjjjjj'] : [])
    const taken = takeArchivable(text, NOW, undefined, STRINGS.en, false, () => true)
    expect(taken.entries).toHaveLength(isDue ? 1 : 0)
    expect(taken.text.includes('session=jjjjjjjj')).toBe(!isDue)
    expect(takeArchivable(text, NOW, undefined, STRINGS.en)).toEqual({ text, entries: [] })
  }
  for (const state of ['ended', 'done']) for (const hours of [60, 100]) {
    const text = ['## alpha', ...askingBlock('jjjjjjjj', state, hours, ['- [?] Pick 24 hours or 7 days?'])].join('\n')
    const isDue = hours > 72
    expect(archivableAsking(text, NOW).map(one => one.ref.session)).toEqual(isDue ? ['jjjjjjjj'] : [])
    expect(takeArchivable(text, NOW, undefined, STRINGS.en, false, () => true).entries).toHaveLength(isDue ? 1 : 0)
    expect(takeArchivable(text, NOW, undefined, STRINGS.en)).toEqual({ text, entries: [] })
  }
})

test('the three days of a block that asks are over only after 72 hours since its last write', () => {
  const at = (hours: number): string => ['## alpha', ...askingBlock('kkkkkkkk', 'ended', hours, ['- [?] Publish the plan, OK?'])].join('\n')
  // Just under, and exactly at, the boundary the block stays; an hour past it, it is listed and taken.
  for (const hours of [60, 71, 72]) {
    expect(archivableAsking(at(hours), NOW)).toEqual([])
    expect(takeArchivable(at(hours), NOW, undefined, STRINGS.en, false, () => true).entries).toEqual([])
  }
  for (const hours of [73, 90]) {
    expect(archivableAsking(at(hours), NOW).map(one => one.ref.session)).toEqual(['kkkkkkkk'])
    expect(takeArchivable(at(hours), NOW, undefined, STRINGS.en, false, () => true).entries).toHaveLength(1)
  }
})

test('a session id shared by two blocks of one project names neither for the question check', () => {
  const shared = ['## alpha', ...askingBlock('llllllll', 'ended', 100, ['- [?] First plan, OK?']), ...askingBlock('llllllll', 'ended', 100, ['- [?] Second plan, OK?'])].join('\n')
  expect(archivableAsking(shared, NOW)).toEqual([])
  // Told apart by their project, the same ids name each.
  const apart = ['## alpha', ...askingBlock('llllllll', 'ended', 100, ['- [?] First plan, OK?']), '## beta', ...askingBlock('llllllll', 'ended', 100, ['- [?] Second plan, OK?'])].join('\n')
  expect(archivableAsking(apart, NOW).map(one => [one.ref.project, one.ref.session])).toEqual([['alpha', 'llllllll'], ['beta', 'llllllll']])
})

test('a question that is only an example in a code fence, or a block never closed, does not hold the archive back or open it', () => {
  const marker = (session: string): string => `<!-- auto session=${session} agent=codex state=ended updated=${new Date(NOW - 100 * HOUR).toISOString()} -->`
  const fenced = ['## beta', marker('gggggggg'), '### Plan gggggggg', '> Context: A code example.', '```', '- [?] Not a real step', '```', '- [x] Done', '<!-- /auto session=gggggggg -->', ''].join('\n')
  expect(archivableAsking(fenced, NOW)).toEqual([])
  expect(takeArchivable(fenced, NOW, undefined, STRINGS.en).entries).toHaveLength(1)
  const unclosed = ['## beta', marker('ffffffff'), '### Plan ffffffff', '- [?] Never closed, OK?', ''].join('\n')
  expect(archivableAsking(unclosed, NOW)).toEqual([])
  expect(takeArchivable(unclosed, NOW, undefined, STRINGS.en, false, () => true).entries).toHaveLength(0)
})

test('asking to tidy at once does not shorten the three days of a block that asks', () => {
  const text = ['## alpha', ...askingBlock('hhhhhhhh', 'done', 14, ['- [?] Pick 24 hours or 7 days?']), ...askingBlock('iiiiiiii', 'ended', 100, ['- [?] Publish the plan, OK?'])].join('\n')
  expect(archivableAsking(text, NOW).map(one => one.ref.session)).toEqual(['iiiiiiii'])
  const { text: kept, entries } = takeArchivable(text, NOW, undefined, STRINGS.en, true, () => true)
  expect(entries).toHaveLength(1)
  expect(kept).toContain('session=hhhhhhhh')
  expect(kept).not.toContain('session=iiiiiiii')
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

// Dropping the sections a removal empties read the whole file again for each of its lines
// (#371): seconds on a board of a few thousand lines, in each session start's archiving and in
// each removal. Done once per removed section, it is a few milliseconds.
const timed = <T,>(work: () => T): [T, number] => {
  const started = performance.now()
  const result = work()
  return [result, performance.now() - started]
}

test('archiving and removing blocks on a board of thousands of lines each take under half the 5 s the host waits', { timeoutMs: 120000 }, () => {
  const board = bigBoard()
  const id = scanBlocks(board.source.split('\n'))[100]?.session ?? ''
  const [taken, archiving] = timed(() => takeArchivable(board.source, BIG_AT, undefined, STRINGS.en))
  const [removed, removing] = timed(() => removeAutoBlock(board.source, id))
  expect(taken.entries).toHaveLength(board.archivable)
  expect(removed).not.toContain(`session=${id}`)
  expect(removed.length).toBeLessThan(board.source.length)
  // A month on, every closed block without a question goes, and with them the sections left empty.
  const later = takeArchivable(board.source, BIG_AT + 30 * 24 * HOUR, undefined, STRINGS.en)
  expect(later.text.match(/^## /gm)?.length).toBeLessThan(board.source.match(/^## /gm)?.length ?? 0)
  // Half the 5 s the host waits: a busy machine stays under it. On an idle machine the old way took
  // 3.4 and 4.3 s, only 1.3 to 1.7 times these budgets, so a fast machine could let it through:
  // the test below, which compares lengths, is the real guard.
  expect(archiving).toBeLessThan(2500)
  expect(removing).toBeLessThan(2500)
})

// A quarter of the busy board, then that quarter four times over (projects and sessions renamed
// per copy): the longer file takes about four times as long; the old way took about sixteen.
// Each operation runs once untimed first, since a first run is slower, then the best of five
// counts, so a pause elsewhere does not. This ratio does not depend on how fast the machine is.
// The old way is slow here too: on main this test runs for over a minute, then fails.
test('archiving and removing a block grow with the length of the file, not with its square', { timeoutMs: 240000 }, () => {
  const one = bigBoard().source.split(/^(?=## )/m).slice(0, 13).join('')
  const copy = (k: number): string => one.replace(/^# Progress\n/, '').replace(/^## project-/gm, `## copy-${k}-project-`).replace(/session=([0-9a-f])([0-9a-f]{7})/g, (_, first: string, rest: string) => `session=${((parseInt(first, 16) + k) % 16).toString(16)}${rest}`)
  const four = [one, copy(1), copy(2), copy(3)].join('\n')
  expect(four.split('\n').length).toBeGreaterThan(4 * one.split('\n').length - 8)
  const id = scanBlocks(one.split('\n'))[20]?.session ?? ''
  expect(id).not.toBe('')
  const best = (work: () => unknown): number => Math.min(...[0, 1, 2, 3, 4].map(() => timed(work)[1]))
  // The short file is timed four times over, so a millisecond of noise does not decide the ratio.
  const ratio = (work: (text: string) => unknown): number => {
    work(one)
    return best(() => work(four)) / Math.max(best(() => { for (let k = 0; k < 4; k++) work(one) }) / 4, 0.01)
  }
  expect(ratio(text => takeArchivable(text, BIG_AT, undefined, STRINGS.en))).toBeLessThan(10)
  expect(ratio(text => removeAutoBlock(text, id))).toBeLessThan(10)
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

test('a future-dated update becomes stale from its first local observation without changing its timestamp', () => {
  for (const state of ['working', 'waiting']) {
    const stamp = NOW + 24 * HOUR
    const text = `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=${state} updated=${new Date(stamp).toISOString()} -->\n### Future clock\n- [~] Finish\n<!-- /auto session=a1b2c3d4 -->`
    const projects = parseProgress(text)
    const seen = withSeen({}, projects, NOW)
    const initial = buildView(projects, [], null, NOW, 0, {}, ZH_TW, [], seen)
    expect(initial.active[0]?.auto).toBe(state)
    const later = buildView(projects, [], null, NOW + STALE_MS + 1, 0, {}, ZH_TW, [], withSeen(seen, projects, NOW + STALE_MS + 1))
    expect(later.active).toEqual([])
    expect(later.stopped[0]?.auto).toBe('ended')
    expect(later.stopped[0]?.when).toContain(ZH_TW.hoursAgo(12))
    expect(later.stopped[0]?.when).toContain('未來時間')
    expect(projects[0]?.tasks[0]?.auto?.updated).toBe(stamp)
    expect(projects[0]?.tasks[0]?.auto?.state).toBe(state)
  }
})

test('polling, a restart and the clock catching up never renew an observed future update', () => {
  const stamp = NOW + 24 * HOUR
  const projects = parseProgress(`## demo\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${new Date(stamp).toISOString()} -->\n### Future clock\n- [~] Finish\n<!-- /auto session=a1b2c3d4 -->`)
  const original = withSeen({}, projects, NOW)
  for (const at of [NOW + HOUR, NOW + STALE_MS + 1, stamp - 4 * 60_000, stamp + HOUR, NOW + IDLE_MS + 1]) {
    const restored = parseSeen(seenJson(original)) ?? {}
    const observed = withSeen(restored, projects, at, {}, true)
    expect(observed).toEqual(original)
    const view = buildView(projects, [], null, at, 0, {}, ZH_TW, [], observed)
    if (at - NOW > STALE_MS) {
      expect(view.active).toEqual([])
      const row = view.stopped[0] ?? view.idle[0]
      expect(row?.auto).toBe('ended')
      expect(row?.when).not.toBe(ZH_TW.justNow)
      expect(row?.when).toContain('未來時間')
    }
  }
})

test('a read-only future row without an observation reports unknown age instead of inventing a fresh time', () => {
  const projects = parseProgress(`## demo\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${new Date(NOW + 24 * HOUR).toISOString()} -->\n### Future clock\n- [~] Finish\n<!-- /auto session=a1b2c3d4 -->`)
  const seen = {}
  for (const at of [NOW, NOW + HOUR, NOW + STALE_MS + 1]) {
    const row = buildView(projects, [], null, at, 0, {}, ZH_TW, [], seen).active[0]
    expect(row?.when).toBe(ZH_TW.futureTimeUnknown)
    expect(row?.when).not.toContain(ZH_TW.justNow)
  }
  expect(seen).toEqual({})
})

test('a changed writer timestamp renews a future observation while a small future offset stays within tolerance', () => {
  const text = (stamp: number): string => `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${new Date(stamp).toISOString()} -->\n### Future clock\n- [~] Finish\n<!-- /auto session=a1b2c3d4 -->`
  const older = withSeen({}, parseProgress(text(NOW + 24 * HOUR)), NOW - STALE_MS - 1)
  const changed = parseProgress(text(NOW + 48 * HOUR))
  const fresh = withSeen(older, changed, NOW, {}, true)
  const view = buildView(changed, [], null, NOW, 0, {}, ZH_TW, [], fresh)
  expect(view.active[0]?.auto).toBe('working')
  expect(view.active[0]?.when).toContain('未來時間')
  const small = parseProgress(text(NOW + 5 * 60_000))
  expect(withSeen({}, small, NOW)).toEqual({})
  expect(buildView(small, [], null, NOW).active[0]?.when).toBe(ZH_TW.justNow)
})

test('recent automatic completions retain future-clock markers in every language', () => {
  for (const s of Object.values(STRINGS)) for (const state of ['done', 'working', 'ended']) for (const isObserved of [false, true]) {
    const projects = parseProgress(`## demo\n<!-- auto session=a1b2c3d4 agent=codex state=${state} updated=${new Date(NOW + 24 * HOUR).toISOString()} -->\n### Future completion\n- [x] Finished\n<!-- /auto session=a1b2c3d4 -->`)
    const seen = isObserved ? withSeen({}, projects, NOW - HOUR) : {}
    const row = buildView(projects, [], null, NOW, 0, {}, s, [], seen).recent[0]
    expect(row?.when).toBe(isObserved ? s.futureTime(s.hoursAgo(1)) : s.futureTimeUnknown)
  }
})

test('every present future update retains its first baseline beyond the manual observation limit', () => {
  const future = Array.from({ length: 501 }, (_, index) => `<!-- auto session=${(0x38200000 + index).toString(16)} agent=codex state=working updated=${new Date(NOW + 24 * HOUR).toISOString()} -->\n### Future worker ${index}\n- [~] Finish\n<!-- /auto session=${(0x38200000 + index).toString(16)} -->`).join('\n')
  const manual = Array.from({ length: 600 }, (_, index) => `### Manual ${index}\n- [ ] Finish`).join('\n')
  const projects = parseProgress(`## demo\n${future}\n${manual}\n`)
  const first = withSeen({}, projects, NOW)
  expect(Object.keys(first).filter(key => /^[0-9a-f]{64}$/.test(key))).toHaveLength(500)
  const restored = parseSeen(seenJson(first)) ?? {}
  for (const task of projects[0]?.tasks ?? []) if (task.auto !== null) expect(restored[futureTimeKey(task.auto)]).toBe(NOW)
  const later = withSeen(restored, projects, NOW + STALE_MS + 1, {}, true)
  const view = buildView(projects, [], null, NOW + STALE_MS + 1, 0, {}, ZH_TW, [], later)
  expect(view.stopped).toHaveLength(501)
  expect(view.active.filter(row => row.auto !== null)).toEqual([])
})

test('future observation grace stays bounded while an empty read preserves known baselines', () => {
  const blocks = Array.from({ length: 600 }, (_, index) => `<!-- auto session=${(0x38200000 + index).toString(16)} agent=codex state=working updated=${new Date(NOW + 24 * HOUR).toISOString()} -->\n### Future ${index}\n- [~] Finish\n<!-- /auto session=${(0x38200000 + index).toString(16)} -->`).join('\n')
  const projects = parseProgress(`## demo\n${blocks}\n`)
  const first = withSeen({}, projects, NOW)
  const empty = withSeen(parseSeen(seenJson(first)) ?? {}, [], NOW + HOUR)
  expect(empty).toEqual(first)
  const restored = withSeen(parseSeen(seenJson(empty)) ?? {}, projects, NOW + STALE_MS + 1, {}, true)
  expect(buildView(projects, [], null, NOW + STALE_MS + 1, 0, {}, ZH_TW, [], restored).stopped).toHaveLength(600)
  const next = parseProgress(`## demo\n<!-- auto session=cafe0382 agent=codex state=working updated=${new Date(NOW + 48 * HOUR).toISOString()} -->\n### New future\n- [~] Finish\n<!-- /auto session=cafe0382 -->`)
  const held = withSeen(restored, next, NOW + HOUR)
  expect(Object.keys(held)).toHaveLength(501)
  expect(Object.keys(withSeen(held, next, NOW + HOUR, {}, true))).toHaveLength(1)
})

test('a stopped task keeps its question on the Stopped shelf and is not counted as In progress', () => {
  const file = '## demo\n<!-- auto session=a1b2c3d4 agent=codex state=ended updated=2026-10-16T11:00:00Z resume=codex-session-123 dir=%2Fw -->\n### Release\n- [?] Publish, OK?\n- [ ] Finish\n<!-- /auto session=a1b2c3d4 -->'
  const view = buildView(parseProgress(file), [], null, NOW)
  expect(view.waiting).toEqual([])
  expect(view.overview.waiting).toBe(0)
  expect(view.overview.active).toBe(0)
  expect(view.active).toEqual([])
  expect(view.groups).toEqual([])
  expect(view.stopped[0]).toMatchObject({ question: 'Publish, OK?', resume: "cd '/w' && codex resume codex-session-123" })
  const hidden = buildView(parseProgress(file), [], null, NOW, 0, {}, ZH_TW, [view.stopped[0]?.questions?.[0]?.hideKey ?? ''])
  expect(hidden.waiting).toEqual([])
  expect(hidden.hidden).toHaveLength(1)
  expect(hidden.stopped).toHaveLength(1)
})

test('a block that asks and has been silent for twelve hours is listed under Stopped with its question, not under Waiting', () => {
  const at = (hours: number): string => ['## alpha', ...askingBlock('a1b2c400', 'waiting', hours, ['- [?] Publish the synthetic plan, OK?'])].join('\n')
  const view = buildView(parseProgress(at(13)), [], null, NOW)
  expect(view.waiting).toEqual([])
  expect(view.overview.waiting).toBe(0)
  expect(view.stopped).toHaveLength(1)
  expect(view.stopped[0]?.questions?.map(question => question.text)).toEqual(['Publish the synthetic plan, OK?'])
  expect(view.overview.stopped).toBe(1)
  const recent = buildView(parseProgress(at(11)), [], null, NOW)
  expect(recent.waiting).toHaveLength(1)
  expect(recent.stopped).toEqual([])
})

test('an explicit done block keeps its unanswered question on the stopped shelf after its recent completion expires', () => {
  const file = '## demo\n<!-- auto session=a1b2c3d4 agent=codex state=done updated=2026-10-15T11:00:00Z -->\n### Release\n- [?] Publish, OK?\n- [ ] Finish\n<!-- /auto session=a1b2c3d4 -->'
  const view = buildView(parseProgress(file), [], null, NOW)
  expect(view.waiting).toEqual([])
  expect(view.active).toEqual([])
  expect(view.stopped).toHaveLength(1)
  expect(view.stopped[0]).toMatchObject({ auto: 'ended', question: 'Publish, OK?' })
  expect(view.stopped[0]?.questions).toHaveLength(1)
})

test('future-clock staleness preserves an unanswered question identity, age and original source', () => {
  const stamp = NOW + 24 * HOUR
  const projects = parseProgress(`## demo\n<!-- auto session=a1b2c3d4 agent=codex state=waiting updated=${new Date(stamp).toISOString()} -->\n### Future question\n- [?] Publish, OK?\n<!-- /auto session=a1b2c3d4 -->`)
  const ledger = observeQuestions(emptyQuestions(), projects, null, [], NOW, true, 'fixture:382').ledger
  const original = ledger.records[0]
  expect(original?.firstObserved).toBe(NOW)
  expect(original?.source).toBeDefined()
  const source = JSON.stringify(original?.source)
  const seen = withSeen({}, projects, NOW)
  const at = NOW + STALE_MS + 1
  const view = buildView(projects, [], null, at, 0, {}, ZH_TW, [], withSeen(seen, projects, at), ledger)
  expect(view.waiting).toEqual([])
  expect(view.stopped[0]?.questions?.map(question => question.questionId)).toEqual([original?.id])
  const kept = observeQuestions(ledger, projects, null, [], at, false, 'preview').ledger.records[0]
  expect(kept?.id).toBe(original?.id)
  expect(kept?.firstObserved).toBe(NOW)
  expect(JSON.stringify(kept?.source)).toBe(source)
  expect(projects[0]?.tasks[0]?.auto?.updated).toBe(stamp)
})

test('explicit actions on an observed future-dated stopped task recheck the same update at the write boundary', () => {
  const text = (stamp: number): string => `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${new Date(stamp).toISOString()} -->\n### Future clock\n- [~] Finish\n<!-- /auto session=a1b2c3d4 -->`
  const original = text(NOW + 24 * HOUR)
  const projects = parseProgress(original)
  const seen = withSeen({}, projects, NOW)
  const at = NOW + STALE_MS + 1
  const row = buildView(projects, [], null, at, 0, {}, ZH_TW, [], seen).stopped[0]
  expect(row?.confirm).not.toBe(null)
  expect(row?.archive).not.toBe(null)
  if (!row?.confirm || !row.archive) throw new Error('stopped row actions missing')
  expect(confirmTask(original, row.confirm, at, ZH_TW, seen)?.text).toContain('state=done')
  const archived = takeTask(original, row.archive, at, ZH_TW, seen)
  expect(archived).not.toBe(null)
  expect(archived?.text).not.toContain('Future clock')
  const changed = text(NOW + 48 * HOUR)
  expect(confirmTask(changed, row.confirm, at, ZH_TW, seen)).toBe(null)
  expect(takeTask(changed, row.archive, at, ZH_TW, seen)).toBe(null)
  expect(takeArchivable(original, at, undefined, ZH_TW, true).text).toBe(original)
})

test('configurable staleness allows completion and archive on quiet sessions and forbids them when active', () => {
  const customStale = 5 * 60 * 1000
  const text = (stamp: number): string => `## demo\n<!-- auto session=a1b2c3d4 agent=codex state=working updated=${new Date(stamp).toISOString()} -->\n### Quiet task\n- [~] Doing\n<!-- /auto session=a1b2c3d4 -->`
  const original = text(NOW)
  const projects = parseProgress(original)
  const seen = withSeen({}, projects, NOW)

  // Active within customStale
  const activeAt = NOW + 4 * 60 * 1000
  const activeView = buildView(projects, [], null, activeAt, 0, {}, ZH_TW, [], seen, undefined, undefined, [], undefined, undefined, customStale)
  expect(activeView.stopped).toHaveLength(0)

  // Stopped past customStale
  const stoppedAt = NOW + 5 * 60 * 1000 + 1
  const stoppedView = buildView(projects, [], null, stoppedAt, 0, {}, ZH_TW, [], seen, undefined, undefined, [], undefined, undefined, customStale)
  expect(stoppedView.stopped).toHaveLength(1)
  const row = stoppedView.stopped[0]
  expect(row?.confirm).not.toBe(null)
  expect(row?.archive).not.toBe(null)
  if (!row?.confirm || !row.archive) throw new Error('stopped row actions missing')
  expect(confirmTask(original, row.confirm, stoppedAt, ZH_TW, seen, customStale)?.text).toContain('state=done')
  const archived = takeTask(original, row.archive, stoppedAt, ZH_TW, seen, customStale)
  expect(archived).not.toBe(null)
  expect(archived?.text).not.toContain('Quiet task')

  // When resumed (newer update within customStale), archive and confirm are disallowed
  const resumed = text(stoppedAt)
  expect(confirmTask(resumed, row.confirm, stoppedAt, ZH_TW, seen, customStale)).toBe(null)
  expect(takeTask(resumed, row.archive, stoppedAt, ZH_TW, seen, customStale)).toBe(null)
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

test('tasks already seen done before the upgrade get their three days from the first run of the new rule', () => {
  const day = 24 * HOUR
  const text = '## demo\n### Finished before upgrade\n- [x] Finished\n'
  const projects = parseProgress(text)
  const task = projects[0]!.tasks[0]!
  const key = taskFingerprint('demo', task)
  const old = withSeen({}, projects, NOW - 10 * day)
  expect(withSeen(old, projects, NOW)).toEqual(old)
  expect(withSeen({}, [], NOW)).toEqual({})
  // Nothing to observe, nothing to write: the reserved entry is written with the first observation.
  expect(withSeen({}, [], NOW, {}, false, true)).toEqual({})
  expect(handKeptSeenAt(old, 'demo', task, NOW)).toBeUndefined()
  const armed = withSeen(old, projects, NOW, {}, false, true)
  expect(Object.keys(armed)[0]).toBe(SWEEP_ARMED_KEY)
  expect(armed[SWEEP_ARMED_KEY]).toBe(NOW)
  expect(armed[key]).toBe(NOW - 10 * day)
  expect(parseSeen(seenJson(armed))).toEqual(armed)
  for (const isSettled of [false, true]) {
    expect(withSeen(armed, [], NOW + day, {}, isSettled, true)[SWEEP_ARMED_KEY]).toBe(NOW)
    expect(withSeen(armed, [], NOW + day, { [SWEEP_ARMED_KEY]: NOW - day }, isSettled)[SWEEP_ARMED_KEY]).toBe(NOW - day)
    expect(withSeen({ [SWEEP_ARMED_KEY]: NOW - day }, [], NOW + day, armed, isSettled)[SWEEP_ARMED_KEY]).toBe(NOW - day)
  }
  // A clock that ran ahead must not hold every task from being due: a future armed time is unknown, and armed again.
  const ahead = { ...armed, [SWEEP_ARMED_KEY]: NOW + day }
  expect(withSeen(ahead, projects, NOW, {}, false, true)[SWEEP_ARMED_KEY]).toBe(NOW)
  expect(SWEEP_ARMED_KEY in withSeen(ahead, projects, NOW)).toBe(false)
  const crowded = parseProgress('## demo\n' + Array.from({ length: 510 }, (_, i) => `### Task ${i}\n- [x] Finished\n`).join(''))
  const capped = parseSeen(seenJson(withSeen(armed, crowded, NOW + day, {}, true, true))) ?? {}
  expect(capped[SWEEP_ARMED_KEY]).toBe(NOW)
  expect(Object.keys(capped)).toHaveLength(501)
  for (const seen of [{}, { [key]: NOW }, { [SWEEP_ARMED_KEY]: NOW }, { ...armed, [key]: NOW + 1 }, { ...armed, [SWEEP_ARMED_KEY]: NOW + 1 }]) {
    expect(handKeptSeenAt(seen, 'demo', task, NOW)).toBeUndefined()
  }
  expect(handKeptSeenAt(armed, 'demo', task, NOW)).toBe(NOW)
  for (const offset of [-1, 0]) {
    const at = NOW + 3 * day + offset
    const age = (_key: string, project: string, item: typeof task) => handKeptSeenAt(armed, project, item, at)
    expect(countManualDone(projects, at, age)).toBe(offset < 0 ? 0 : 1)
    expect(takeManualDone(text, at, age).entries).toHaveLength(offset < 0 ? 0 : 1)
  }
  const later = { ...armed, [key]: NOW + day }
  expect(handKeptSeenAt(later, 'demo', task, NOW + day)).toBe(NOW + day)
  for (const offset of [-1, 0]) {
    const at = NOW + 4 * day + offset
    expect(countManualDone(projects, at, (_key, project, item) => handKeptSeenAt(later, project, item, at))).toBe(offset < 0 ? 0 : 1)
  }
})

test('a sweep over the synthetic big board counts in under a second and moves nothing open', () => {
  const day = 24 * HOUR
  const marks = [' ', '~', '?', '>', '!']
  const appended = Array.from({ length: 40 }, (_, index) => `### Synthetic completion ${index}\n- [x] Finished\n- [${index < 30 ? '-' : marks[(index - 30) % marks.length]}] Last step\n`).join('')
  const text = `${bigBoard().source}\n## Sweep sample\n${appended}`
  const projects = parseProgress(text)
  const seen = { ...withSeen({}, projects, BIG_AT - 30 * day), [SWEEP_ARMED_KEY]: BIG_AT - 4 * day }
  const age = (_key: string, project: string, task: typeof projects[number]['tasks'][number]) => handKeptSeenAt(seen, project, task, BIG_AT)
  const countStart = Date.now()
  const count = countManualDone(projects, BIG_AT, age)
  expect(Date.now() - countStart).toBeLessThan(1000)
  const takeStart = Date.now()
  const out = takeManualDone(text, BIG_AT, age)
  expect(Date.now() - takeStart).toBeLessThan(1000)
  expect(count).toBe(30)
  expect(out.entries).toHaveLength(count)
  for (const entry of out.entries) expect(entry).not.toMatch(/- \[[ ~?>!]\]/)
  // One scan of each text, not one per block: a block's lines must come through the sweep unchanged.
  const linesOf = (one: string): string[] => one.replace(/\r?\n$/, '').split(/\r?\n/)
  const before = linesOf(text)
  const after = linesOf(out.text)
  const spansBefore = scanBlocks(before)
  const spansAfter = scanBlocks(after)
  expect(spansAfter.map(span => [span.session, span.state, span.updated])).toEqual(spansBefore.map(span => [span.session, span.state, span.updated]))
  spansBefore.forEach((span, index) => {
    const kept = spansAfter[index]!
    expect(after.slice(kept.start, kept.end + 1)).toEqual(before.slice(span.start, span.end + 1))
  })
  const remaining = new Set(parseProgress(out.text).flatMap(project => project.tasks.map(task => taskFingerprint(project.name, task))))
  for (const project of projects) for (const task of project.tasks) {
    if (task.auto !== null || task.steps.some(step => step.status !== 'done' && step.status !== 'cancelled')) expect(remaining.has(taskFingerprint(project.name, task))).toBe(true)
  }
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
  // The manual tasks were observed earlier; this future-dated block arrives now.
  const beforeFuture = projects.map(project => ({ ...project, tasks: project.tasks.filter(task => task.title !== 'Future') }))
  const seen = withSeen(withSeen({}, beforeFuture, NOW - IDLE_MS - 1), projects, NOW)
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

test('tidy takes a verified run of any age without keeping its question and respects keep and closed markers', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  const block = (id: string, isClosed = true): string => `<!-- auto session=${id} agent=codex state=working updated=2026-10-27T12:00:00Z -->
### Synthetic run
- [?] Ship it, OK?
${isClosed ? `<!-- /auto session=${id} -->` : ''}
`
  const text = '## demo\n' + block('aaaa1111') + block('bbbb2222') + block('cccc3333', false)
  const taken = takeArchivable(text, now, 'bbbb2222', ZH_TW, false, () => false, () => true)
  expect(taken.entries).toHaveLength(1)
  expect(taken.entries[0]).toContain('Ship it, OK?')
  expect(taken.text).not.toContain('session=aaaa1111')
  expect(taken.text).toContain('session=bbbb2222')
  expect(taken.text).toContain('session=cccc3333')
})

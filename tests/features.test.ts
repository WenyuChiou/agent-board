import { expect, test } from 'claude-code/testing'

import type { ProgressMirror, ProgressPr } from '../types'
import { askOf } from '../hooks/ask'
import { addManualTask, isArchivable, takeArchivable, takeManualDone, upsertAutoBlock } from '../hooks/blocks'
import { dashboardHtml } from '../hooks/dashboard'
import { ciFinished, prFromGh, prWords } from '../hooks/github'
import { appendJournal, countDay, journalLine, parseJournal, progressReport } from '../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, cleanContext, cleanTitle, clip, completedSince, emptyMirror, noticesOf } from '../hooks/mirror'
import { DARK, LIGHT, paletteFor } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { LANGS, ZH_TW } from '../hooks/i18n'
import { resolveLang, STRINGS } from '../hooks/strings'
import { parseQuickAdd } from '../hooks/quick'
import { buildView, resumeCommand, statusLine } from '../hooks/view'

const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const SESSION = '2be48af2-6193-5040-aacc-e0546d6784f1'

const PR: ProgressPr = {
  number: 12,
  url: 'https://github.com/WenyuChiou/claude-progress-pane/pull/12',
  state: 'open',
  isDraft: false,
  ci: 'fail',
  failed: 2,
  review: 'changes',
}

const working = (): ProgressMirror => {
  let mirror = emptyMirror(SESSION, 'persona_framework', NOW, 'C:\\Users\\wenyu\\my repo')
  mirror = applyTaskCreate(mirror, { subject: '讀 API' }, '1', NOW)
  mirror = applyTaskCreate(mirror, { subject: '寫 Mod' }, '2', NOW)
  mirror = applyTaskUpdate(mirror, { taskId: '1', status: 'completed' }, NOW)

  return { ...mirror, title: '重做進度面板', state: 'working' }
}

test('the marker carries the resume id, the folder and the pull request, and reads back', () => {
  const text = upsertAutoBlock('', { ...working(), pr: PR })
  expect(text).toContain(`resume=${SESSION}`)
  expect(text).toContain('dir=C%3A%5CUsers%5Cwenyu%5Cmy%20repo')
  expect(text).toContain('pr=12 ci=fail -->')
  expect(text).toContain('> Claude 正在做 · PR #12 · CI 失敗 2 · 要求修改')

  const auto = parseProgress(text)[0]?.tasks[0]?.auto
  expect(auto).toMatchObject({ session: '2be48af2', resume: SESSION, dir: 'C:\\Users\\wenyu\\my repo', pr: 12, ci: 'fail' })
})

test("gh's answer becomes one word for CI, and words for the card", () => {
  const answer = (rollup: unknown[], extra: object = {}): string =>
    JSON.stringify({ number: 7, url: 'https://x/pull/7', state: 'OPEN', isDraft: false, statusCheckRollup: rollup, reviewDecision: '', ...extra })
  const run = (status: string, conclusion = ''): object => ({ __typename: 'CheckRun', status, conclusion })

  expect(prFromGh(answer([]))).toMatchObject({ ci: 'none', failed: 0 })
  expect(prFromGh(answer([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')]))?.ci).toBe('pass')
  expect(prFromGh(answer([run('COMPLETED', 'SUCCESS'), { state: 'PENDING' }]))?.ci).toBe('pending')
  expect(prFromGh(answer([run('IN_PROGRESS'), run('COMPLETED', 'FAILURE'), { state: 'ERROR' }]))).toMatchObject({ ci: 'fail', failed: 2 })
  expect(prFromGh(answer([], { state: 'MERGED', reviewDecision: 'APPROVED' }))).toMatchObject({ state: 'merged', review: 'approved' })
  expect(prFromGh('no pull requests found')).toBe(null)

  expect(prWords(PR)).toBe('PR #12 · CI 失敗 2 · 要求修改')
  expect(prWords({ ...PR, state: 'merged' })).toBe('PR #12 · 已合併')
  expect(prWords({ ...PR, isDraft: true, ci: 'pending', review: null })).toBe('PR #12 · 草稿 · CI 跑中')

  expect(ciFinished({ ...PR, ci: 'pending' }, PR)).toBe('PR #12 CI 失敗 2')
  expect(ciFinished({ ...PR, ci: 'pending' }, { ...PR, ci: 'pass', failed: 0 })).toBe('PR #12 CI 通過')
  expect(ciFinished(PR, PR)).toBe(null)
  expect(ciFinished(null, PR)).toBe(null)
})

test('a quick add reads the project, the due date and the steps', () => {
  expect(parseQuickAdd('+ 求職：Google 暑期實習 截止 11/01；改履歷；投遞', 'persona_framework')).toEqual({
    project: '求職',
    title: 'Google 暑期實習',
    due: '11-01',
    steps: ['改履歷', '投遞'],
  })
  // Job hunting given no steps gets the usual ones.
  expect(parseQuickAdd('+求職: Meta 實習', 'x')?.steps).toEqual(ZH_TW.jobSteps)
  // No project: this session's; no steps: the task is its own step; a URL's colon is no project.
  expect(parseQuickAdd('＋ 讀 https://arxiv.org/abs/2410.1', 'persona_framework')).toEqual({
    project: 'persona_framework',
    title: '讀 https://arxiv.org/abs/2410.1',
    due: null,
    steps: ['讀 https://arxiv.org/abs/2410.1'],
  })
  expect(parseQuickAdd('+  ', 'x')).toBe(null)
})

test('a quick add lands at the end of its section, or a new one, and reads back with its date', () => {
  const file = '# 專案進度\n\n## 求職\n### Google 暑期實習\n- [ ] 投遞\n\n## persona_framework\n- [ ] 其他\n'
  const entry = { project: '求職', title: 'Meta 實習', due: '11-20', steps: ['改履歷', '投遞'] }
  const added = addManualTask(file, entry)
  expect(added).toBe(
    '# 專案進度\n\n## 求職\n### Google 暑期實習\n- [ ] 投遞\n\n### Meta 實習\n> 截止 11-20\n- [ ] 改履歷\n- [ ] 投遞\n\n## persona_framework\n- [ ] 其他\n',
  )
  expect(parseProgress(added)[0]?.tasks[1]).toMatchObject({ title: 'Meta 實習', due: '11-20' })

  expect(addManualTask(file, { ...entry, project: '論文' })).toContain('- [ ] 其他\n\n## 論文\n\n### Meta 實習\n')
  expect(addManualTask('', entry)).toBe('# 專案進度\n\n## 求職\n\n### Meta 實習\n> 截止 11-20\n- [ ] 改履歷\n- [ ] 投遞\n')
})

test('finished steps are found once, journaled as lines, and read back', () => {
  const before = working()
  const after = applyTaskUpdate(before, { taskId: '2', status: 'completed' }, NOW)
  expect(completedSince(before, after).map(task => task.subject)).toEqual(['寫 Mod'])
  expect(completedSince(after, after)).toEqual([])

  const line = journalLine({ project: 'persona_framework', task: 'A · B', step: '寫 Mod' }, NOW)
  expect(line).toMatch(/^- 2026-10-1\d \d\d:\d\d · persona_framework · A・B · 寫 Mod$/)
  const text = appendJournal(appendJournal('', [line]), [line.replace('寫 Mod', '推分支')])
  expect(text.startsWith('# 工作日誌\n- ')).toBe(true)
  expect(parseJournal(text).map(entry => [entry.project, entry.task, entry.step])).toEqual([
    ['persona_framework', 'A・B', '寫 Mod'],
    ['persona_framework', 'A・B', '推分支'],
  ])
})

test('the report groups what finished by task, then lists open work and what waits on you', () => {
  const day = 24 * 60 * 60 * 1000
  const entries = [
    ...parseJournal(journalLine({ project: 'persona_framework', task: '重做進度面板', step: '讀 API' }, NOW)),
    ...parseJournal(journalLine({ project: 'persona_framework', task: '重做進度面板', step: '寫 Mod' }, NOW - day)),
    ...parseJournal(journalLine({ project: '求職', task: 'Google 暑期實習', step: '改履歷' }, NOW - 2 * day)),
    ...parseJournal(journalLine({ project: '舊的', task: '上個月', step: '不該出現' }, NOW - 20 * day)),
  ]
  const projects = parseProgress('## 求職\n### Google 暑期實習\n- [x] 改履歷\n- [?] 推薦信\n- [ ] 投遞\n')
  const report = progressReport(entries, projects, working(), NOW, 7)

  expect(report).toContain('- persona_framework · 重做進度面板：讀 API、寫 Mod')
  expect(report).toContain('- 求職 · Google 暑期實習：改履歷')
  expect(report).not.toContain('不該出現')
  expect(report).toContain('進行中\n- persona_framework · 重做進度面板：下一步 寫 Mod (1/2)\n- 求職 · Google 暑期實習：下一步 推薦信 (1/3)')
  expect(report).toContain('等我處理\n- 求職 · 推薦信')

  expect(progressReport([], [], null, NOW, 1)).toContain('（這段時間沒有完成的步驟紀錄）')
})

test('a step that needs you and a finished list each notify once', () => {
  const before = working()
  const waiting = applyTaskUpdate(before, { taskId: '2', metadata: { waiting: 'you' } }, NOW)
  expect(noticesOf(before, waiting)).toEqual(['需要你：寫 Mod'])
  expect(noticesOf(waiting, waiting)).toEqual([])
  const done = applyTaskUpdate(waiting, { taskId: '2', status: 'completed' }, NOW)
  expect(noticesOf(waiting, done)).toEqual(['做完了：重做進度面板（2/2）'])
  expect(noticesOf(done, done)).toEqual([])
})

test('an ended session offers the command that reopens it where it ran', () => {
  expect(resumeCommand(SESSION, "C:\\Users\\wenyu\\o'neil repo")).toBe(
    `Set-Location -LiteralPath 'C:\\Users\\wenyu\\o''neil repo'; claude --resume ${SESSION}`,
  )
  expect(resumeCommand(SESSION, "/home/me/o'neil")).toBe(`cd '/home/me/o'\\''neil' && claude --resume ${SESSION}`)
  expect(resumeCommand(SESSION, null)).toBe(`claude --resume ${SESSION}`)

  const file = `## FLOODABM
<!-- auto session=dddddddd state=ended updated=2026-10-16T10:00:00.000Z resume=dddddddd-1111 dir=%2Fwork%2FFLOODABM pr=3 ci=pass -->
### 跑實驗
- [x] 準備資料
- [ ] 跑 100 次
<!-- /auto session=dddddddd -->
`
  const [row] = buildView(parseProgress(file), ['persona_framework'], null, NOW).active
  expect(row?.resume).toBe("cd '/work/FLOODABM' && claude --resume dddddddd-1111")
  expect(row?.pr).toBe('PR #3 · CI 通過')
})

test('the status line says where things stand, and nothing when nothing does', () => {
  const projects = parseProgress('## 求職\n### Google 暑期實習\n> 截止 10-18\n- [?] 推薦信\n')
  const line = statusLine(buildView(projects, [], { ...working(), pr: PR }, NOW))
  expect(line).toBe('進度 · 重做進度面板 1/2 · Claude 正在做 · 1 件等你 · 1 件快到期 · PR #12 · CI 失敗 2 · 要求修改')
  expect(statusLine(buildView([], [], null, NOW))).toBe(undefined)
})

test('two 和色 sets: the light one under a light theme, the dark one otherwise', () => {
  expect(paletteFor('light')).toBe(LIGHT)
  expect(paletteFor('light-ansi')).toBe(LIGHT)
  expect(paletteFor('dark')).toBe(DARK)
  expect(paletteFor('auto')).toBe(DARK)
  for (const set of [DARK, LIGHT]) {
    for (const hex of Object.values(set)) expect(hex).toMatch(/^#[0-9A-F]{6}$/)
  }
})

test('other work is grouped by project, this one first, with numbered steps, notes and background', () => {
  const file = `## 求職
### Google 暑期實習
> 寫推薦信的是王教授 · 截止 12-20
- [x] 改履歷
- [?] 推薦信 — 等教授回覆

## persona_framework
<!-- auto session=cccccccc state=ended updated=2026-10-16T11:00:00.000Z -->
### 修 CI
> 對話已結束，可接手
> 背景：PR #12 的 e2e 測試在 Windows 上會逾時
- [x] 看 log
- [ ] 修
<!-- /auto session=cccccccc -->
`
  const view = buildView(parseProgress(file), ['persona_framework'], null, NOW, 4)
  expect(view.groups.map(group => [group.project, group.isHere, group.rows.map(row => row.title)])).toEqual([
    ['persona_framework', true, ['修 CI']],
    ['求職', false, ['Google 暑期實習']],
  ])
  const [ci] = view.groups[0]?.rows ?? []
  expect(ci?.context).toBe('PR #12 的 e2e 測試在 Windows 上會逾時')
  expect(ci?.steps.map(step => [step.number, step.text])).toEqual([
    [1, '看 log'],
    [2, '修'],
  ])
  const google = view.groups[1]?.rows[0]
  expect(google?.context).toBe('寫推薦信的是王教授')
  expect(google?.steps[1]).toMatchObject({ number: 2, text: '推薦信', note: '等教授回覆' })
  expect(view.overview).toEqual({ waiting: 1, active: 2, due: 0, today: 4 })
})

test('the model answer becomes a title and a line of background', () => {
  expect(cleanContext('背景：想在右側一眼看到各專案做到哪')).toBe('想在右側一眼看到各專案做到哪')
  expect(cleanContext('「Background: 為了週會」')).toBe('為了週會')
  expect([...cleanContext('長'.repeat(80))]).toHaveLength(60)
  const day = journalLine({ project: 'a', task: 'b', step: 'c' }, NOW)
  expect(countDay(`${day}\n${day}\n- 2020-01-01 10:00 · a · b · old\n`, NOW)).toBe(2)
})

test('what a waiting step asks decides its buttons: confirm, choose, do, review, input, wait', () => {
  expect(askOf('推上分支', '可以推到 main 嗎？')).toMatchObject({ kind: 'confirm' })
  expect(askOf('確認 A/B 指標', '用 win rate 還是 Elo？之後的報表都照這個算')).toEqual({
    kind: 'choose',
    options: ['win rate', 'Elo'],
    command: null,
    link: null,
  })
  expect(askOf('安裝', '在本機跑 `setup.ps1`')).toMatchObject({ kind: 'do', command: 'setup.ps1' })
  expect(askOf('預覽', '看一下 https://claude.ai/artifact/abc 的配色')).toMatchObject({
    kind: 'review',
    link: 'https://claude.ai/artifact/abc',
  })
  expect(askOf('金鑰', 'API key 放在哪個檔？')).toMatchObject({ kind: 'input' })
  expect(askOf('推薦信', '等王教授回覆')).toMatchObject({ kind: 'wait' })
  expect(askOf('其他', '')).toMatchObject({ kind: 'reply' })
  // What Claude said wins over what the words imply.
  expect(askOf('版號', '這版叫什麼', { ask: 'choose', options: ['0.7.0', '1.0.0'] })).toMatchObject({
    kind: 'choose',
    options: ['0.7.0', '1.0.0'],
  })
})

test('the focus is the most pressing thing: an answer here, then elsewhere, then today, then stuck, then waiting on others', () => {
  const day = 24 * 60 * 60 * 1000
  const iso = (ms: number): string => new Date(ms).toISOString()
  const file = (extra: string): string => `## 求職
### Google 暑期實習
> 截止 10-16
- [ ] 投遞

## awesome
### 發佈
- [!] 簡中鏡像 — 第 5 階段還沒翻

## 研究
### 推薦信
- [?] 推薦信 — 等王教授回覆
${extra}`
  const other = `
## AutoResearchAgent
<!-- auto session=7f3c19ab agent=codex state=waiting updated=${iso(NOW - 60 * 1000)} -->
### Stage 2
- [?] 指標 — 用 win rate 還是 Elo？
<!-- /auto session=7f3c19ab -->
`
  let mine = applyTaskUpdate(working(), { taskId: '2', metadata: { waiting: 'you', why: '可以推到 main 嗎？' } }, NOW)
  let view = buildView(parseProgress(file(other)), [], mine, NOW)
  expect(view.focus).toMatchObject({ type: 'ask', item: { where: 'here', kind: 'confirm', text: '寫 Mod' } })
  expect(view.waiting.map(item => [item.where, item.kind, item.agent])).toEqual([
    ['here', 'confirm', ''],
    ['other', 'choose', 'codex'],
    ['manual', 'wait', ''],
  ])

  mine = working()
  view = buildView(parseProgress(file(other)), [], mine, NOW)
  expect(view.focus).toMatchObject({ type: 'ask', item: { where: 'other', options: ['win rate', 'Elo'] } })

  view = buildView(parseProgress(file('')), [], mine, NOW)
  expect(view.focus).toMatchObject({ type: 'due', row: { title: 'Google 暑期實習' } })

  view = buildView(parseProgress(file('').replace('截止 10-16', '截止 10-30')), [], mine, NOW)
  expect(view.focus).toMatchObject({ type: 'blocked', row: { title: '發佈' } })

  view = buildView(parseProgress('## 研究\n### 推薦信\n- [?] 推薦信 — 等王教授回覆\n'), [], mine, NOW)
  expect(view.focus).toMatchObject({ type: 'ask', item: { kind: 'wait' } })
  expect(buildView([], [], null, NOW + day).focus).toBe(null)
})

test('a session silent for half a day counts as stopped: its questions stay in its row, not in 等你處理', () => {
  const iso = (ms: number): string => new Date(ms).toISOString()
  const file = (updated: number): string => `## FLOODABM
<!-- auto session=dddddddd agent=claude state=waiting updated=${iso(updated)} resume=dddddddd-1 dir=%2Fw -->
### 跑實驗
- [x] 準備資料
- [?] 要不要重跑 — 可以重跑嗎？
<!-- /auto session=dddddddd -->
`
  const live = buildView(parseProgress(file(NOW - 60 * 60 * 1000)), [], null, NOW)
  expect(live.waiting).toHaveLength(1)

  const stopped = buildView(parseProgress(file(NOW - 13 * 60 * 60 * 1000)), [], null, NOW)
  expect(stopped.waiting).toHaveLength(0)
  expect(stopped.overview.waiting).toBe(0)
  expect(stopped.active[0]).toMatchObject({ auto: 'ended', status: '對話已停，13 小時前沒動靜', resume: "cd '/w' && claude --resume dddddddd-1" })
  expect(stopped.groups[0]?.summary).toBe('1 件 · 1 已停')
})

test('finished hand-kept tasks leave a day after they were first seen done, whole, and nothing else moves', () => {
  const day = 24 * 60 * 60 * 1000
  const text = `# 專案進度

## 求職
### Google 暑期實習
> 截止 10-31
- [x] 改履歷
- [x] 投遞

### Meta 實習
- [x] 改履歷
- [ ] 投遞

## 研究
### 讀論文
- [x] 讀完
`
  const seen: Record<string, number> = { 'done:求職::Google 暑期實習': NOW - 2 * day, 'done:研究::讀論文': NOW - day / 2 }
  const out = takeManualDone(text, NOW, key => seen[key])
  expect(out.keys).toEqual(['done:求職::Google 暑期實習'])
  expect(out.entries).toEqual(['## 求職 · 2026-10-14\n### Google 暑期實習\n> 截止 10-31\n- [x] 改履歷\n- [x] 投遞'])
  expect(out.text).toBe('# 專案進度\n\n## 求職\n### Meta 實習\n- [x] 改履歷\n- [ ] 投遞\n\n## 研究\n### 讀論文\n- [x] 讀完\n')
  // Never seen done: stays until the pane has seen it.
  expect(takeManualDone(text, NOW, () => undefined).entries).toEqual([])
})

test('blocks leave after half a day when done and after three days otherwise', () => {
  const span = (state: 'done' | 'ended' | 'working', hours: number) => ({
    session: 'x',
    state,
    updated: NOW - hours * 60 * 60 * 1000,
    project: 'p',
    start: 0,
    end: 1,
    isClosed: true,
  })
  expect(isArchivable(span('done', 13), NOW)).toBe(true)
  expect(isArchivable(span('done', 11), NOW)).toBe(false)
  expect(isArchivable(span('ended', 73), NOW)).toBe(true)
  expect(isArchivable(span('ended', 47), NOW)).toBe(false)
  expect(isArchivable(span('working', 73), NOW)).toBe(true)
})

test('languages: the setting, the stored choice and the system pick the language, in that order', () => {
  expect(resolveLang('en', 'zh-CN', 'japanese', 'zh_TW.UTF-8')).toBe('en')
  expect(resolveLang('auto', 'zh-CN', 'english', 'zh_TW.UTF-8')).toBe('zh-CN')
  expect(resolveLang('auto', undefined, '繁體中文', undefined)).toBe('zh-TW')
  expect(resolveLang('auto', undefined, 'Chinese', undefined)).toBe('zh-CN')
  expect(resolveLang(undefined, undefined, undefined, 'zh_TW.UTF-8')).toBe('zh-TW')
  expect(resolveLang(undefined, undefined, undefined, 'de_DE.UTF-8')).toBe('en')
  // Every language has every word, functions included.
  for (const lang of LANGS) {
    const s = STRINGS[lang]
    expect(Object.keys(s)).toEqual(Object.keys(ZH_TW))
    expect(typeof s.daysLeft(3)).toBe('string')
    expect(s.lang).toBe(lang)
  }
})

test('a file written in English reads back: Context, due, and an English quick add', () => {
  const file = '## Job search\n### Google internship\n> Context: the recruiter asked for a portfolio link\n> due 10-18\n- [x] Update résumé\n- [?] Reference — waiting for Prof. Wang\n'
  const [task] = parseProgress(file)[0]?.tasks ?? []
  expect(task?.due).toBe('10-18')
  const [row] = buildView(parseProgress(file), [], null, NOW, 0, {}, STRINGS.en).due
  expect(row).toMatchObject({ context: 'the recruiter asked for a portfolio link', due: { left: '2 days left' } })
  // `overdue 3-4` is not a due date; a year may use /.
  expect(parseProgress('### a\n> overdue 3-4\n- [ ] x\n')[0]?.tasks[0]?.due).toBe(null)
  expect(parseProgress('### a\n> due 2026/10/31\n- [ ] x\n')[0]?.tasks[0]?.due).toBe('2026-10-31')

  const entry = parseQuickAdd('+ Job search: Meta internship due 11-20', 'x', STRINGS.en)
  expect(entry?.steps).toEqual(STRINGS.en.jobSteps)
  expect(addManualTask('', entry as NonNullable<typeof entry>, STRINGS.en)).toBe(
    '# Project progress\n\n## Job search\n\n### Meta internship\n> due 11-20\n- [ ] Update résumé\n- [ ] Write cover letter\n- [ ] Apply\n- [ ] Follow up\n',
  )
})

test('English questions: a yes or no is a confirm, "or" inside a word is no choice, waiting reads the step too', () => {
  expect(askOf('Push', 'Push 0.7.0 to main?')).toMatchObject({ kind: 'confirm' })
  expect(askOf('Deploy', 'Should I deploy it to staging?')).toMatchObject({ kind: 'confirm' })
  expect(askOf('Check', 'Is this OK for production?')).toMatchObject({ kind: 'confirm', options: [] })
  expect(askOf('Metric', 'win rate or Elo?')).toMatchObject({ kind: 'choose', options: ['win rate', 'Elo'] })
  expect(askOf('Waiting on CI', '')).toMatchObject({ kind: 'wait' })
})

test('a choice with a comma before 還是 / or still reads both options', () => {
  expect(askOf('上線方式', '先用旗標給部分人，還是直接全部開？')).toMatchObject({
    kind: 'choose',
    options: ['先用旗標給部分人', '直接全部開'],
  })
  expect(askOf('Release plan', 'Behind a flag first, or everyone at once?')).toMatchObject({
    kind: 'choose',
    options: ['Behind a flag first', 'everyone at once'],
  })
  expect(askOf('確認 A/B 指標', '之後的報表都照這個算：win rate 還是 Elo？')).toMatchObject({
    options: ['win rate', 'Elo'],
  })
})

test('archiving never ages out a block with no time, and keeps a section someone left empty', () => {
  const text = `# P

## Ideas

## done-stuff
<!-- auto session=aaaaaaaa agent=codex state=done updated=2026-10-10T00:00:00.000Z -->
### Old
- [x] one
<!-- /auto session=aaaaaaaa -->

## untimed
<!-- auto session=bbbbbbbb agent=codex state=done -->
### Whenever
- [x] one
<!-- /auto session=bbbbbbbb -->
`
  const out = takeArchivable(text, NOW)
  expect(out.entries).toHaveLength(1)
  expect(out.text).toContain('## Ideas\n')
  expect(out.text).not.toContain('## done-stuff')
  expect(out.text).toContain('session=bbbbbbbb')
})

test('progress.html shows the whole file: counts, the focus, folded sections, steps, and escapes what it shows', () => {
  const file = `## 求職
### Google <script>alert(1)</script>
> 截止 10-18
- [x] 改履歷
- [?] 推薦信 — 等王教授回覆
- [ ] 投遞

## AutoResearchAgent
<!-- auto session=7f3c19ab agent=codex state=waiting updated=2026-10-16T11:50:00.000Z -->
### Stage 2
- [?] 指標 — 用 win rate 還是 Elo？
<!-- /auto session=7f3c19ab -->
`
  const view = buildView(parseProgress(file), [], null, NOW, 3, {}, STRINGS['zh-TW'])
  const html = dashboardHtml(view, STRINGS['zh-TW'], '/home/me/.claude/progress.md', '更新於 2026-10-16 20:00')
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('<html lang="zh-Hant">')
  expect(html).toContain('@media (prefers-color-scheme:dark)')
  expect(html).toContain('● 2</span> 等你')
  expect(html).toContain('✓ 3</span> 今天完成')
  expect(html).toContain('<div class="label">現在最需要你</div>')
  expect(html).toContain('〔選一個〕')
  expect(html).toContain('AutoResearchAgent › Stage 2 · codex')
  expect(html).toContain('data-key="section:waiting" open')
  expect(html).toContain('Google &lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)')
  expect(html).toContain('location.reload()')
  expect(dashboardHtml(view, STRINGS.en, 'p', 'updated now')).toContain('<html lang="en">')
})

test('可以 / 能不能 opening a question make a confirm; a date that does not exist is no due date; the journal speaks the pane language', () => {
  expect(askOf('推上', '可以推到 main')).toMatchObject({ kind: 'confirm' })
  expect(askOf('暫停', '能不能先停一下')).toMatchObject({ kind: 'confirm' })
  const view = buildView(parseProgress('## P\n\n### Odd date\n> due 13-45\n- [ ] a\n'), [], null, NOW, 0, {}, STRINGS.en)
  expect(view.due).toEqual([])
  expect(journalLine({ project: '', task: 'Task', step: 'Step' }, NOW, STRINGS.en)).toContain(' · (unnamed) · Task · Step')
})

test('titles and background are cut by terminal width, at a word in English, never mid-word', () => {
  expect(cleanTitle('Add README describing index.js')).toBe('Add README describing index.js')
  expect(cleanTitle('Move the payment webhook to the new queue and retry duplicates safely')).toBe(
    'Move the payment webhook to the new queue and…',
  )
  expect([...cleanTitle('長'.repeat(30))]).toHaveLength(24)
  expect(cleanContext('A README is needed so newcomers can understand index.js and run it without asking anyone')).toBe(
    'A README is needed so newcomers can understand index.js and run it without asking anyone',
  )
  expect([...cleanContext('長'.repeat(80))]).toHaveLength(60)
  expect(clip('Add a README.md to this repo describing index.js', 38)).toBe('Add a README.md to this repo…')
})

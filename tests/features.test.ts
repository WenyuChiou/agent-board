import { expect, test } from 'claude-code/testing'

import type { ProgressMirror, ProgressPr } from '../types'
import { addManualTask, upsertAutoBlock } from '../hooks/blocks'
import { ciFinished, prFromGh, prWords } from '../hooks/github'
import { appendJournal, countDay, journalLine, parseJournal, progressReport } from '../hooks/journal'
import { applyTaskCreate, applyTaskUpdate, cleanContext, completedSince, emptyMirror, noticesOf } from '../hooks/mirror'
import { DARK, LIGHT, paletteFor } from '../hooks/palette'
import { parseProgress } from '../hooks/parse'
import { JOB_STEPS, parseQuickAdd } from '../hooks/quick'
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
  expect(parseQuickAdd('+求職: Meta 實習', 'x')?.steps).toEqual(JOB_STEPS)
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
  expect(report).toContain('進行中\n- persona_framework · 重做進度面板：下一步 寫 Mod（1/2）\n- 求職 · Google 暑期實習：下一步 推薦信（1/3）')
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

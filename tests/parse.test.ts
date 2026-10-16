import { expect, test } from 'claude-code/testing'

import { currentStepIndex, isHereProject, parseProgress } from '../hooks/parse'

const SAMPLE = `# 專案進度

## alpha
### 修登入
> fix/login · 截止 10-31
- [x] 重現
- [~] 修 token 過期
- [?] 確認要不要登出所有裝置
- [>] 跑 CI
- [!] 部署 — 缺金鑰
- [-] 改 UI
- [ ] 開 PR

## persona_framework (PFC)
<!-- auto session=2be48af2 state=waiting updated=2026-10-16T10:00:00.000Z -->
### 進度面板
> 等你回覆
- [x] 讀 API
- [ ] 寫測試
  - [ ] 子步驟
<!-- /auto session=2be48af2 -->

\`\`\`
## not-a-project
- [ ] not a step
\`\`\`

<!--
## hidden
-->
`

test('reads projects, tasks, notes, every status and the due date', () => {
  const projects = parseProgress(SAMPLE)
  expect(projects.map(p => p.name)).toEqual(['alpha', 'persona_framework (PFC)'])

  const login = projects[0]?.tasks[0]
  expect(login?.title).toBe('修登入')
  expect(login?.due).toBe('10-31')
  expect(login?.auto).toBe(null)
  expect(login?.steps.map(s => s.status)).toEqual([
    'done',
    'doing',
    'waiting',
    'running',
    'blocked',
    'cancelled',
    'todo',
  ])
})

test('a block between auto markers carries its session, state and time', () => {
  const panel = parseProgress(SAMPLE)[1]?.tasks[0]
  expect(panel?.title).toBe('進度面板')
  expect(panel?.auto).toEqual({
    session: '2be48af2',
    agent: 'claude',
    state: 'waiting',
    updated: Date.parse('2026-10-16T10:00:00.000Z'),
    resume: null,
    dir: null,
    pr: null,
    ci: null,
  })
  expect(panel?.steps.map(s => s.depth)).toEqual([0, 0, 1])
})

test('highlights the [~] step, else the first open one', () => {
  const [alpha, pfc] = parseProgress(SAMPLE)
  expect(alpha?.tasks[0] && currentStepIndex(alpha.tasks[0])).toBe(1)
  expect(pfc?.tasks[0] && currentStepIndex(pfc.tasks[0])).toBe(1)
})

test('steps without a ### heading still land in a task', () => {
  const [only] = parseProgress('## 求職\n- [ ] 改履歷\n- [x] 問推薦人\n')
  expect(only?.tasks).toHaveLength(1)
  expect(only?.tasks[0]?.steps).toHaveLength(2)
})

test('a project heading matches the repo it names', () => {
  expect(isHereProject('Persona_Framework — PFC', ['persona_framework'])).toBe(true)
  expect(isHereProject('alpha', ['persona_framework'])).toBe(false)
})

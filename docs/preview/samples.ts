// Sample data for the README images: the same morning in three languages. One Claude session
// (the pane's own), a Codex block, a Gemini block, a session that ended, hand-kept tasks with
// due dates, and finished work. Names are made up.
export const NOW = Date.parse('2026-10-16T09:40:00+08:00')
export const MIN = 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()
export const SESSION = '2be48af2-6193-5040-aacc-e0546d6784f1'

type Step = [subject: string, status: 'completed' | 'in_progress' | 'pending', metadata?: Record<string, unknown>]

export type Sample = {
  project: string
  path: string
  mine: { title: string; context: string; branch: string; steps: Step[] }
  file: string
  journal: Array<[days: number, project: string, task: string, step: string]>
  quickAdd: string
}

export const SAMPLES: Record<string, Sample> = {
  en: {
    project: 'acme-web',
    path: '/Users/ana/.claude/progress.md',
    mine: {
      title: 'Add a dark mode',
      context: 'Users asked for it in the last survey; it should follow the system theme',
      branch: 'feat/dark-mode',
      steps: [
        ['Add colour tokens for dark', 'completed'],
        ['Wire the theme switch', 'completed'],
        ['Fix contrast on charts', 'in_progress'],
        ['Release plan', 'pending', { waiting: 'you', ask: 'choose', options: ['Behind a flag', 'Everyone'], why: 'Behind a flag first, or everyone at once?' }],
        ['Open the pull request', 'pending'],
      ],
    },
    file: `# Project progress

## api-gateway
<!-- auto session=7f3c19ab agent=codex state=waiting updated=${iso(NOW - 25 * MIN)} pr=41 ci=fail -->
### Rate-limit the public endpoints
> Waiting for your reply · codex/rate-limit · PR #41
> Context: a few abusive keys took the API down twice last month
- [x] Measure traffic per key
- [x] Add the token bucket
- [?] Per-key limit — 100 or 300 a minute?
- [ ] Load test on staging
<!-- /auto session=7f3c19ab -->

## data-pipeline
<!-- auto session=a81d0c42 agent=gemini state=working updated=${iso(NOW - 6 * MIN)} -->
### Backfill last year's events
> Context: the warehouse lost three months in the migration
- [x] Export the raw logs
- [~] Replay March to May
- [?] Warehouse login — run \`gcloud auth login\` on your machine
- [ ] Check the row counts
<!-- /auto session=a81d0c42 -->

## acme-web
<!-- auto session=b72e4d19 agent=claude state=ended updated=${iso(NOW - 3 * 60 * MIN)} resume=00000000-0000-0000-0000-000000000001 dir=%2FUsers%2Fana%2Facme-web -->
### Upgrade to React 19
> Session ended, open to take over
> Context: the old version blocks the new router
> Handoff: packages bumped; 12 tests fail on the new router; next, fix them
- [x] Bump the packages
- [ ] Fix the failing tests
- [ ] Remove the old polyfills
<!-- /auto session=b72e4d19 -->

## Job search
### Northwind summer internship
> due 10-18
> The team works on agent evaluation, close to my research
- [x] Tailor the resume
- [~] Write the cover letter
- [ ] Submit

### Contoso research residency
> due 10-31
- [x] Update the resume
- [?] Recommendation letter — waiting for Prof. Lee to reply
- [ ] Submit

## paper-review
### Annotate 800 samples
> 8 annotators, then Krippendorff's alpha
- [x] Send out the sheets
- [>] Collect ratings — 312 of 800 back
- [ ] Compute agreement

## docs-site
### Publish the October release notes
- [x] English text
- [?] Check the preview — https://docs.example.com/preview/2026-10
- [!] Japanese mirror — translator is out until Monday
- [ ] Tag and deploy

## mobile-app
<!-- auto session=c55e2f10 agent=claude state=done updated=${iso(NOW - 3 * 60 * MIN)} -->
### Release 1.7.4
> Done
- [x] Update the changelog
- [x] Tag the release
- [x] Submit to the store
<!-- /auto session=c55e2f10 -->
`,
    journal: [
      [0, 'acme-web', 'Add a dark mode', 'Add colour tokens for dark'],
      [0, 'acme-web', 'Add a dark mode', 'Wire the theme switch'],
      [0, 'Job search', 'Northwind summer internship', 'Tailor the resume'],
      [0, 'mobile-app', 'Release 1.7.4', 'Tag the release'],
      [0, 'mobile-app', 'Release 1.7.4', 'Submit to the store'],
      [1, 'data-pipeline', "Backfill last year's events", 'Export the raw logs'],
      [2, 'api-gateway', 'Rate-limit the public endpoints', 'Add the token bucket'],
      [3, 'paper-review', 'Annotate 800 samples', 'Send out the sheets'],
    ],
    quickAdd: '+ Job search: Fabrikam fellowship due 11-20; update the resume; submit',
  },

  'zh-TW': {
    project: 'acme-web',
    path: 'C:\\Users\\ana\\.claude\\progress.md',
    mine: {
      title: '設定頁加上深色模式',
      context: '上次問卷很多人要；預設跟著系統主題切換',
      branch: 'feat/dark-mode',
      steps: [
        ['加深色的顏色 token', 'completed'],
        ['接上主題切換', 'completed'],
        ['修圖表對比', 'in_progress'],
        ['上線方式', 'pending', { waiting: 'you', ask: 'choose', options: ['先開旗標', '全部開'], why: '先用旗標給部分人，還是直接全部開？' }],
        ['開 PR', 'pending'],
      ],
    },
    file: `# 專案進度

## api-gateway
<!-- auto session=7f3c19ab agent=codex state=waiting updated=${iso(NOW - 25 * MIN)} pr=41 ci=fail -->
### 公開 API 加流量限制
> 等你回覆 · codex/rate-limit · PR #41
> 背景：上個月有幾把金鑰濫用，API 掛了兩次
- [x] 量每把金鑰的流量
- [x] 加 token bucket
- [?] 每把上限 — 每分鐘 100 還是 300？
- [ ] 在 staging 壓測
<!-- /auto session=7f3c19ab -->

## data-pipeline
<!-- auto session=a81d0c42 agent=gemini state=working updated=${iso(NOW - 6 * MIN)} -->
### 回補去年的事件資料
> 背景：搬資料倉儲時掉了三個月
- [x] 匯出原始 log
- [~] 重播三到五月
- [?] 倉儲登入 — 在你電腦上跑 \`gcloud auth login\`
- [ ] 核對筆數
<!-- /auto session=a81d0c42 -->

## acme-web
<!-- auto session=b72e4d19 agent=claude state=ended updated=${iso(NOW - 3 * 60 * MIN)} resume=00000000-0000-0000-0000-000000000001 dir=C%3A%5CUsers%5Cana%5Cacme-web -->
### 升級到 React 19
> 對話已結束，可接手
> 背景：舊版擋住新的 router
> 交接：套件升好了；新 router 讓 12 個測試壞掉；下一步修測試
- [x] 升套件版本
- [ ] 修壞掉的測試
- [ ] 拿掉舊 polyfill
<!-- /auto session=b72e4d19 -->

## 求職
### Northwind 暑期實習
> 截止 10-18
> 團隊做 agent 評測，跟我的研究最接近
- [x] 調整履歷重點
- [~] 寫 cover letter
- [ ] 投遞

### Contoso 研究駐點
> 截止 10-31
- [x] 改履歷
- [?] 推薦信 — 等李教授回覆
- [ ] 投遞

## paper-review
### 標註 800 筆
> 8 位標註者，算 Krippendorff α
- [x] 發出評分表
- [>] 收評分 — 回來 312/800
- [ ] 算一致性

## docs-site
### 發布十月版本說明
- [x] 英文內容
- [?] 看一下預覽 — https://docs.example.com/preview/2026-10
- [!] 日文版 — 譯者休假到週一
- [ ] 打 tag 並部署

## mobile-app
<!-- auto session=c55e2f10 agent=claude state=done updated=${iso(NOW - 3 * 60 * MIN)} -->
### 發布 1.7.4
> 完成
- [x] 更新 CHANGELOG
- [x] 打 tag
- [x] 送審上架
<!-- /auto session=c55e2f10 -->
`,
    journal: [
      [0, 'acme-web', '設定頁加上深色模式', '加深色的顏色 token'],
      [0, 'acme-web', '設定頁加上深色模式', '接上主題切換'],
      [0, '求職', 'Northwind 暑期實習', '調整履歷重點'],
      [0, 'mobile-app', '發布 1.7.4', '打 tag'],
      [0, 'mobile-app', '發布 1.7.4', '送審上架'],
      [1, 'data-pipeline', '回補去年的事件資料', '匯出原始 log'],
      [2, 'api-gateway', '公開 API 加流量限制', '加 token bucket'],
      [3, 'paper-review', '標註 800 筆', '發出評分表'],
    ],
    quickAdd: '+ 求職：Fabrikam 研究獎助 截止 11-20；改履歷；投遞',
  },

  'zh-CN': {
    project: 'acme-web',
    path: '/home/li/.claude/progress.md',
    mine: {
      title: '设置页加上深色模式',
      context: '上次问卷很多人要；默认跟着系统主题切换',
      branch: 'feat/dark-mode',
      steps: [
        ['加深色的颜色 token', 'completed'],
        ['接上主题切换', 'completed'],
        ['修图表对比度', 'in_progress'],
        ['上线方式', 'pending', { waiting: 'you', ask: 'choose', options: ['先开开关', '全部开放'], why: '先用开关给部分用户，还是直接全部开放？' }],
        ['提 PR', 'pending'],
      ],
    },
    file: `# 项目进度

## api-gateway
<!-- auto session=7f3c19ab agent=codex state=waiting updated=${iso(NOW - 25 * MIN)} pr=41 ci=fail -->
### 公开 API 加限流
> 等你回复 · codex/rate-limit · PR #41
> 背景：上个月几个密钥被滥用，API 挂了两次
- [x] 统计每个密钥的流量
- [x] 加 token bucket
- [?] 每个密钥的上限 — 每分钟 100 还是 300？
- [ ] 在 staging 压测
<!-- /auto session=7f3c19ab -->

## data-pipeline
<!-- auto session=a81d0c42 agent=gemini state=working updated=${iso(NOW - 6 * MIN)} -->
### 回补去年的事件数据
> 背景：迁移数据仓库时丢了三个月
- [x] 导出原始日志
- [~] 重放三到五月
- [?] 仓库登录 — 在你电脑上运行 \`gcloud auth login\`
- [ ] 核对条数
<!-- /auto session=a81d0c42 -->

## acme-web
<!-- auto session=b72e4d19 agent=claude state=ended updated=${iso(NOW - 3 * 60 * MIN)} resume=00000000-0000-0000-0000-000000000001 dir=%2Fhome%2Fli%2Facme-web -->
### 升级到 React 19
> 对话已结束，可接手
> 背景：旧版本挡住了新的 router
> 交接：包升好了；新 router 让 12 个测试挂掉；下一步修测试
- [x] 升级依赖版本
- [ ] 修失败的测试
- [ ] 删掉旧的 polyfill
<!-- /auto session=b72e4d19 -->

## 求职
### Northwind 暑期实习
> 截止 10-18
> 团队做 agent 评测，和我的研究最接近
- [x] 调整简历重点
- [~] 写 cover letter
- [ ] 投递

### Contoso 研究驻点
> 截止 10-31
- [x] 改简历
- [?] 推荐信 — 等李教授回复
- [ ] 投递

## paper-review
### 标注 800 条
> 8 位标注员，算 Krippendorff α
- [x] 发出评分表
- [>] 收评分 — 回来 312/800
- [ ] 算一致性

## docs-site
### 发布十月版本说明
- [x] 英文内容
- [?] 看一下预览 — https://docs.example.com/preview/2026-10
- [!] 日文版 — 译者休假到周一
- [ ] 打 tag 并部署

## mobile-app
<!-- auto session=c55e2f10 agent=claude state=done updated=${iso(NOW - 3 * 60 * MIN)} -->
### 发布 1.7.4
> 完成
- [x] 更新 CHANGELOG
- [x] 打 tag
- [x] 提交商店审核
<!-- /auto session=c55e2f10 -->
`,
    journal: [
      [0, 'acme-web', '设置页加上深色模式', '加深色的颜色 token'],
      [0, 'acme-web', '设置页加上深色模式', '接上主题切换'],
      [0, '求职', 'Northwind 暑期实习', '调整简历重点'],
      [0, 'mobile-app', '发布 1.7.4', '打 tag'],
      [0, 'mobile-app', '发布 1.7.4', '提交商店审核'],
      [1, 'data-pipeline', '回补去年的事件数据', '导出原始日志'],
      [2, 'api-gateway', '公开 API 加限流', '加 token bucket'],
      [3, 'paper-review', '标注 800 条', '发出评分表'],
    ],
    quickAdd: '+ 求职：Fabrikam 研究资助 截止 11-20；改简历；投递',
  },
}

// The terminal board (`--watch`) for the README's pair of CLI pictures: a Codex CLI session
// and an Antigravity CLI session each waiting on the person, beside Claude Code still at work.
// No resume id or folder: a picture shows nothing a person would have to blank out.
type CliTask = { title: string; done: string[]; ask: string; context?: string; next?: string }
const cliFile = (w: { codex: CliTask; antigravity: CliTask; claude: { title: string; done: string[]; doing: string } }): string => `# Project progress

## api-gateway
<!-- auto session=3c9e5a71 agent=codex state=waiting updated=${iso(NOW - 4 * MIN)} -->
### ${w.codex.title}
${w.codex.context === undefined ? '' : `> Context: ${w.codex.context}\n`}${w.codex.done.map(step => `- [x] ${step}`).join('\n')}
- [?] ${w.codex.ask}
<!-- /auto session=3c9e5a71 -->

## data-pipeline
<!-- auto session=8d21f0b4 agent=antigravity state=waiting updated=${iso(NOW - 9 * MIN)} -->
### ${w.antigravity.title}
${w.antigravity.done.map(step => `- [x] ${step}`).join('\n')}
- [?] ${w.antigravity.ask}
${w.antigravity.next === undefined ? '' : `- [ ] ${w.antigravity.next}\n`}<!-- /auto session=8d21f0b4 -->

## acme-web
<!-- auto session=b72e4d19 agent=claude state=working updated=${iso(NOW - 2 * MIN)} -->
### ${w.claude.title}
${w.claude.done.map(step => `- [x] ${step}`).join('\n')}
- [~] ${w.claude.doing}
<!-- /auto session=b72e4d19 -->
`

export const CLI_FILES: Record<string, string> = {
  en: cliFile({
    codex: { title: 'Fix the CSV export', context: 'exports over 10 MB time out', done: ['Reproduce the timeout', 'Stream the rows'], ask: 'Open the pull request, OK?' },
    antigravity: { title: 'Check the clean install', done: ['Install on a fresh machine'], ask: 'Keep the logs — 24 hours or 7 days?', next: 'Run the final checks' },
    claude: { title: 'Add a dark mode', done: ['Add colour tokens'], doing: 'Fix contrast on charts' },
  }),
  'zh-TW': cliFile({
    codex: { title: '修好 CSV 匯出', context: '超過 10 MB 的匯出會逾時', done: ['重現逾時', '改成分批輸出'], ask: '可以開 pull request 嗎？' },
    antigravity: { title: '驗證乾淨安裝', done: ['在新電腦上安裝'], ask: '日誌保留 — 24 小時還是 7 天？', next: '跑最後的檢查' },
    claude: { title: '設定頁加上深色模式', done: ['加深色的顏色 token'], doing: '修圖表對比' },
  }),
  'zh-CN': cliFile({
    codex: { title: '修好 CSV 导出', context: '超过 10 MB 的导出会超时', done: ['复现超时', '改成分批输出'], ask: '可以开 pull request 吗？' },
    antigravity: { title: '验证干净安装', done: ['在新电脑上安装'], ask: '日志保留 — 24 小时还是 7 天？', next: '跑最后的检查' },
    claude: { title: '设置页加上深色模式', done: ['加深色的颜色 token'], doing: '修图表对比度' },
  }),
}

// The README's animated cover: half a minute of one morning on the terminal board
// (`agent-board --watch`). Claude Code, Codex, Antigravity and OpenCode each report into one
// file through their own hooks and tick their steps; Codex asks whether to open its pull
// request and the person answers from the board; the person passes what Claude chose on to
// Codex (a preview of Send to Codex, #318, milestone 0.24.2) and Codex ticks that step; last, Antigravity
// asks something new. The moments are COVER_MARKS. No resume id or folder, as in the CLI sample.
export const COVER_AGENTS = ['claude', 'codex', 'antigravity', 'opencode'] as const
export type CoverAgent = (typeof COVER_AGENTS)[number]
// `asks` is how a step reads while it waits on the person, by its index.
export type CoverTask = { project: string; title: string; steps: string[]; asks?: Record<number, string> }
export type CoverSample = {
  tasks: Record<CoverAgent, CoverTask>
  // What the person writes to Codex, as the reply box shows it on two lines.
  message: [string, string]
}

export const COVER: Record<string, CoverSample> = {
  en: {
    tasks: {
      claude: { project: 'acme-web', title: 'Add a dark mode', steps: ['Add colour tokens', 'Fix contrast on charts', 'Write the release note', 'Open the pull request'] },
      codex: { project: 'api-gateway', title: 'Add rate limits', steps: ['Add the token bucket', 'Load test on staging', 'Open the pull request', 'Name the rollout flag', 'Update the API docs'], asks: { 2: 'Open the pull request, OK?' } },
      antigravity: { project: 'docs-site', title: 'Publish the release notes', steps: ['Write the English text', 'Build the Japanese page', 'Pick the release day', 'Tag and deploy'], asks: { 2: 'Release today, or Monday?' } },
      opencode: { project: 'mobile-app', title: 'Fix the login crash', steps: ['Reproduce on Android', 'Patch the token refresh', 'Ship a beta build'] },
    },
    message: ['Call the rollout flag', 'dark-mode, please.'],
  },
  'zh-TW': {
    tasks: {
      claude: { project: 'acme-web', title: '設定頁加上深色模式', steps: ['加上深色配色 token', '修圖表對比度', '寫版本說明', '開 PR'] },
      codex: { project: 'api-gateway', title: '加上流量限制', steps: ['加上 token bucket', '在 staging 壓測', '開 PR', '幫上線旗標取名', '更新 API 文件'], asks: { 2: '可以開 pull request 嗎？' } },
      antigravity: { project: 'docs-site', title: '發布版本說明', steps: ['寫英文內容', '做日文頁面', '決定哪天發布', '打 tag 並部署'], asks: { 2: '今天發布，還是等週一？' } },
      opencode: { project: 'mobile-app', title: '修好登入閃退', steps: ['在 Android 上重現', '修 token 更新', '出 beta 版'] },
    },
    message: ['上線旗標就叫', 'dark-mode 吧。'],
  },
  'zh-CN': {
    tasks: {
      claude: { project: 'acme-web', title: '设置页加上深色模式', steps: ['加上深色配色 token', '修图表对比度', '写版本说明', '提 PR'] },
      codex: { project: 'api-gateway', title: '加上限流', steps: ['加上 token bucket', '在 staging 压测', '提 PR', '给上线开关取名', '更新 API 文档'], asks: { 2: '可以开 pull request 吗？' } },
      antigravity: { project: 'docs-site', title: '发布版本说明', steps: ['写英文内容', '做日文页面', '决定哪天发布', '打 tag 并部署'], asks: { 2: '今天发布，还是等周一？' } },
      opencode: { project: 'mobile-app', title: '修复登录闪退', steps: ['在 Android 上复现', '修 token 刷新', '出 beta 版'] },
    },
    message: ['上线开关就叫', 'dark-mode 吧。'],
  },
}

// Each agent's step marks at each of the cover's 15 moments, in progress.md's own marks; null
// while the agent is not on the board yet. 0–3: the agents come in; 4–7: steps tick; 8: Claude's
// task closes, nothing else changes; 9: Codex asks; 10–11: the person picks the question and
// copies the answer; 12: Codex opened the pull request; 13: Codex named the flag it was told;
// 14: Antigravity asks.
const marks = (...runs: Array<[count: number, marks: string | null]>): Array<string | null> => runs.flatMap(([count, value]) => Array<string | null>(count).fill(value))
export const COVER_MARKS: Record<CoverAgent, Array<string | null>> = {
  claude: marks([5, 'x~  '], [10, 'xx~ ']),
  codex: marks([1, null], [5, 'x~   '], [3, 'xx~  '], [3, 'xx?  '], [1, 'xxx~ '], [2, 'xxxx~']),
  antigravity: marks([2, null], [5, 'x~  '], [7, 'xx~ '], [1, 'xx? ']),
  opencode: marks([3, null], [12, 'x~ ']),
}
export const COVER_MOMENTS = 15

const COVER_SESSIONS: Record<CoverAgent, string> = { claude: 'b72e4d19', codex: '3c9e5a71', antigravity: '8d21f0b4', opencode: '5e0a9c37' }
// How long ago each agent last reported, in minutes, until its first step on the cover; then
// just now.
const COVER_AGO: Record<CoverAgent, number> = { claude: 2, codex: 3, antigravity: 4, opencode: 6 }

// progress.md at moment `moment`: one block per agent on the board by then, a step that waits
// on the person worded as its question, and the block waiting while it asks.
export const coverFile = (sample: CoverSample, moment: number): string => {
  const blocks = COVER_AGENTS.flatMap(agent => {
    const now = COVER_MARKS[agent][moment]
    if (now === null || now === undefined) return []
    const first = COVER_MARKS[agent].find(value => value !== null)
    const hasMoved = COVER_MARKS[agent].slice(0, moment + 1).some(value => value !== null && value !== first)
    const task = sample.tasks[agent]
    const steps = task.steps.map((step, i) => {
      const mark = now[i] ?? ' '
      return `- [${mark}] ${mark === '?' ? (task.asks?.[i] ?? step) : step}`
    })
    const state = now.includes('?') ? 'waiting' : 'working'
    const session = COVER_SESSIONS[agent]
    return [`## ${task.project}
<!-- auto session=${session} agent=${agent} state=${state} updated=${iso(NOW - (hasMoved ? 0 : COVER_AGO[agent]) * MIN)} -->
### ${task.title}
${steps.join('\n')}
<!-- /auto session=${session} -->
`]
  })
  return `# Project progress\n\n${blocks.join('\n')}`
}

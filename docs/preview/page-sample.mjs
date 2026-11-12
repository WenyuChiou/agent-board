// The made-up morning the README's page shots show, in three languages: one Claude Code task
// asking a short question, three tasks from other agents, one finished. Names are invented; the
// wording follows COVER in samples.ts so the README's pictures tell one story.
const MIN = 60 * 1000

const TASKS = {
  en: {
    claude: { project: 'acme-web', title: 'Add a dark mode', steps: ['Add colour tokens', 'Fix contrast on charts', 'Release today, or Monday?', 'Tag and deploy'] },
    codex: { project: 'api-gateway', title: 'Add rate limits', steps: ['Add the token bucket', 'Load test on staging', 'Open the pull request', 'Update the API docs'] },
    antigravity: { project: 'docs-site', title: 'Publish the release notes', steps: ['Write the English text', 'Build the Japanese page', 'Tag and deploy'] },
    opencode: { project: 'mobile-app', title: 'Fix the login crash', steps: ['Reproduce on Android', 'Patch the token refresh', 'Ship a beta build'] },
    done: { project: 'acme-web', title: 'Update the sign-up copy', steps: ['Draft the new text', 'Review with design'] },
  },
  'zh-TW': {
    claude: { project: 'acme-web', title: '設定頁加上深色模式', steps: ['加上深色配色 token', '修圖表對比度', '今天發布，還是等週一？', '打 tag 並部署'] },
    codex: { project: 'api-gateway', title: '加上流量限制', steps: ['加上 token bucket', '在 staging 壓測', '開 PR', '更新 API 文件'] },
    antigravity: { project: 'docs-site', title: '發布版本說明', steps: ['寫英文內容', '做日文頁面', '打 tag 並部署'] },
    opencode: { project: 'mobile-app', title: '修好登入閃退', steps: ['在 Android 上重現', '修 token 更新', '出 beta 版'] },
    done: { project: 'acme-web', title: '更新註冊頁文案', steps: ['寫新文案', '和設計一起檢查'] },
  },
  'zh-CN': {
    claude: { project: 'acme-web', title: '设置页加上深色模式', steps: ['加上深色配色 token', '修图表对比度', '今天发布，还是等周一？', '打 tag 并部署'] },
    codex: { project: 'api-gateway', title: '加上限流', steps: ['加上 token bucket', '在 staging 压测', '提 PR', '更新 API 文档'] },
    antigravity: { project: 'docs-site', title: '发布版本说明', steps: ['写英文内容', '做日文页面', '打 tag 并部署'] },
    opencode: { project: 'mobile-app', title: '修复登录闪退', steps: ['在 Android 上复现', '修 token 刷新', '出 beta 版'] },
    done: { project: 'acme-web', title: '更新注册页文案', steps: ['写新文案', '和设计一起检查'] },
  },
}

// Each agent's step marks and how many minutes ago it last reported, so the page reads
// "2 min ago" whenever the picture is made.
const BLOCKS = [
  ['claude', 'b72e4d19', 'waiting', 'xx? ', 2],
  ['codex', '3c9e5a71', 'working', 'xx~ ', 1],
  ['antigravity', '8d21f0b4', 'working', 'x~ ', 3],
  ['opencode', '5e0a9c37', 'working', 'x~ ', 5],
  ['done', '1f6a7d02', 'done', 'xx', 20],
]

export const pageFile = (lang, now = Date.now()) => {
  const tasks = TASKS[lang]
  const blocks = BLOCKS.map(([key, session, state, marks, ago]) => {
    const task = tasks[key]
    const steps = task.steps.map((step, i) => `- [${marks[i] ?? ' '}] ${step}`)
    const agent = key === 'done' ? 'claude' : key
    return `## ${task.project}
<!-- auto session=${session} agent=${agent} state=${state} updated=${new Date(now - ago * MIN).toISOString()} -->
### ${task.title}
${steps.join('\n')}
<!-- /auto session=${session} -->
`
  })
  return `# Project progress\n\n${blocks.join('\n')}`
}

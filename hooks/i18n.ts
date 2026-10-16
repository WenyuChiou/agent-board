import type { AskKind } from './ask'

// Every word the person reads, in each language the pane speaks. ZH_TW is the reference:
// EN and ZH_CN (strings-en.ts, strings-zh-cn.ts) have exactly its shape, so a missing or
// mistyped entry is a type error. Words written into progress.md are here too; the parser
// reads the keywords of every language (背景 / Context, 截止 / due), so files written in one
// language read in another.

export type Lang = 'en' | 'zh-TW' | 'zh-CN'

export const LANGS: readonly Lang[] = ['en', 'zh-TW', 'zh-CN']

export const ZH_TW = {
  lang: 'zh-TW' as Lang,

  // Time and dates
  justNow: '剛剛',
  minutesAgo: (n: number): string => `${n} 分鐘前`,
  hoursAgo: (n: number): string => `${n} 小時前`,
  yesterday: '昨天',
  daysAgo: (n: number): string => `${n} 天前`,
  overdue: (n: number): string => `已過 ${n} 天`,
  dueToday: '今天截止',
  daysLeft: (n: number): string => `還有 ${n} 天`,

  // Where a task or step stands
  stuck: (text: string): string => `卡住：${text}`,
  waitsOnYou: (text: string): string => `等你：${text}`,
  runningStep: (text: string): string => `在跑：${text}`,
  doingStep: (text: string): string => `正在做：${text}`,
  nextStep: (text: string): string => `下一步：${text}`,
  noSteps: '還沒列步驟',
  suffixCancelled: '（取消）',
  suffixWaiting: '（等你）',
  suffixRunning: '（在跑）',
  suffixBlocked: '（卡住）',
  foldedDone: (n: number): string => `已完成 ${n} 步`,
  foldedRest: (n: number): string => `還有 ${n} 步`,
  waitingReply: '等你回覆',
  allDone: '全部完成',
  claudeWorking: 'Claude 正在做',
  agentWorking: (agent: string): string => `${agent} 正在做`,
  sessionStopped: (when: string): string => `對話已停，${when}沒動靜`,
  sessionEnded: '對話已結束，可接手',
  uncategorized: '（未分類）',
  unnamed: '（未命名）',
  groupCount: (n: number): string => `${n} 件`,
  groupWaiting: (n: number): string => `${n} 等你`,
  groupStuck: (n: number): string => `${n} 卡住`,
  groupStopped: (n: number): string => `${n} 已停`,
  groupWorking: (n: number): string => `${n} 在做`,

  // The line under the prompt
  statusPrefix: '進度',
  statusWaiting: (n: number): string => `${n} 件等你`,
  statusDue: (n: number): string => `${n} 件快到期`,

  // Pull requests
  ciPass: 'CI 通過',
  ciFail: (n: number): string => (n > 0 ? `CI 失敗 ${n}` : 'CI 失敗'),
  ciPending: 'CI 跑中',
  reviewApproved: '已核准',
  reviewChanges: '要求修改',
  reviewRequired: '等審查',
  prMerged: '已合併',
  prClosed: '已關閉',
  prDraft: '草稿',

  // What a waiting step asks
  ask: {
    confirm: '確認',
    choose: '選一個',
    input: '填資料',
    do: '動手',
    review: '看一下',
    wait: '等別人',
    reply: '回覆',
  } as Record<AskKind, string>,
  chip: (word: string): string => `〔${word}〕`,
  answerText: (subject: string, answer: string): string => `關於「${subject}」：${answer}`,

  // Desktop notifications
  noticeNeedsYou: (text: string): string => `需要你：${text}`,
  noticeDone: (title: string, n: number): string => `做完了：${title}（${n}/${n}）`,
  noticeCi: (pr: number, words: string): string => `PR #${pr} ${words}`,
  notifyTitle: (project: string): string => `進度 · ${project}`,

  // Words written into progress.md and its archive and journal
  stateWorking: 'Claude 正在做',
  stateWaiting: '等你回覆',
  stateDone: '完成',
  stateEnded: '對話已結束，可接手',
  fileTitle: '# 專案進度',
  contextNote: (text: string): string => `> 背景：${text}`,
  dueNote: (date: string): string => `> 截止 ${date}`,
  archiveTitle: '# 進度封存',
  journalTitle: '# 工作日誌',
  defaultProject: '待辦',

  // The report 週報 copies
  reportToday: (day: string): string => `今天的進度（${day}）`,
  reportDays: (n: number, from: string, to: string): string => `最近 ${n} 天的進度（${from} – ${to}）`,
  reportDone: '完成',
  reportNone: '- （這段時間沒有完成的步驟紀錄）',
  reportOpen: '進行中',
  reportWaiting: '等我處理',
  reportNext: (text: string): string => `下一步 ${text}`,
  listSep: '、',
  pairSep: '：',

  // Quick add
  jobSteps: ['改履歷', '寫求職信', '投遞', '追蹤回覆'],
  quickAdded: (project: string, title: string, steps: number, due: string | null): string =>
    `已加進「${project}」：${title}（${steps} 步${due === null ? '' : `，截止 ${due}`}）`,
  quickEmpty: '要加什麼？例如「+ 求職：Google 實習 截止 11-01；改履歷；投遞」。',
  quickUnreadable: '讀不到進度檔，沒有加進去。',

  // Text sent to Claude (or to Haiku), in the person's language
  namePrompt: (request: string, steps: string): string =>
    `使用者的需求：\n${request}\n\n步驟：\n${steps}\n\n` +
    '回兩行，用繁體中文，不要引號：\n' +
    '第一行：這件工作的名稱，4 到 14 個字，像待辦清單的標題：白話、具體、說出要做成什麼，不要標點。\n' +
    '第二行：一句 40 字以內的背景，給一個沒看過這段對話的人看：為什麼要做、做完會怎樣。',
  asideSuffix: '（側邊面板的問題：用繁體中文、三句以內回答，不要動任何檔案。）',
  asideNotStarted: '這個對話還沒開始，先跟 Claude 說一句話再問。',
  asideFailed: '沒問到，再試一次。',
  resumeHead: '[進度面板] 對話剛壓縮過。壓縮前的進度（同步自 Task 清單）：',
  resumeGoal: (title: string, project: string): string => `目標：${title}（${project}）`,
  resumeContext: (text: string): string => `背景：${text}`,
  resumeDone: (done: number, total: number): string => `完成 ${done}/${total}`,
  resumeDoing: (text: string): string => `正在做：${text}`,
  resumeNext: (list: string): string => `接下來：${list}`,
  resumeWaiting: (list: string): string => `等使用者或卡住：${list}`,
  resumeTail: '先用 TaskList 確認最新狀態，再從「正在做」那步接著做；不要重建已經存在的任務。',
  compactKeep: '保留 Task 清單上每一步的狀態，特別是正在做的那一步和還沒做的步驟。',
  othersHead: '[進度面板] 這個專案在 progress.md 裡還有其他對話的工作：',
  othersEnded: (title: string, step: string, done: number, total: number): string =>
    `- 「${title}」對話已結束，停在：${step}（完成 ${done}/${total}）`,
  othersHeld: (title: string, done: number, total: number): string => `- 「${title}」另一個對話正在處理（完成 ${done}/${total}）`,
  othersTail: '只有在使用者要接著做時才接手；接手時用 TaskCreate 重建剩下的步驟。不要重做另一個對話正在處理的事。',
  none: '（無）',
  takeOverHead: (title: string, project: string, done: number, total: number): string =>
    `接手「${title}」（${project}，之前的對話沒做完，完成 ${done}/${total}）。`,
  takeOverLeft: (list: string): string => `剩下：${list}`,
  takeOverTail: '先用 TaskCreate 重建剩下的步驟，再從第一個沒做完的開始。',
  handOverHead: (title: string, project: string): string => `幫我處理「${title}」（${project}）。`,
  handOverContext: (text: string): string => `背景：${text}。`,
  handOverNext: (step: string): string => `下一步是「${step}」。`,
  handOverTail: 'progress.md 裡這個任務的段落是目前的狀態，做完一步就在那裡打勾。',
  continueText: '繼續',
  stepSep: '；',

  // /progress
  commandDescription: '進度面板：開啟；open 開網頁版、整理、同步、加 …、週報、今天、通知 開/關、lang en|zh-TW|zh-CN',
  commandHint: '[open|整理|同步|加 …|週報|今天|通知 開/關|lang …]',
  tidyUnreadable: '讀不到進度檔或封存檔，沒有動任何檔案。',
  tidyNothing: '沒有要封存的。',
  tidyMoved: (n: number): string => `封存了 ${n} 個完成的任務。`,
  synced: '已從 Task 清單重新同步。',
  copiedSuffix: '（已複製到剪貼簿）',
  notifyOn: '桌面通知已打開：需要你、做完、CI 跑完時會通知。',
  notifyOff: '桌面通知已關掉。',
  paneOpened: (path: string): string => `進度面板已開啟：${path}`,
  paneNotOpened: (reason: string): string => `進度面板開不了：${reason}`,
  langSet: '面板改用繁體中文。',
  langUnknown: '支援的語言：en、zh-TW、zh-CN、auto。',

  // The pane
  paneTitle: '進度',
  legendWords: ['完成', '正在做', '還沒做', '等你', '在跑', '卡住', '取消'],
  now: ' ← 現在',
  replyElsewhere: (project: string, agent: string): string => `到 ${project} 的對話${agent === '' ? '' : `（${agent}）`}回覆，這裡回不了。`,
  arrivedDone: '到了，完成',
  done: '完成',
  reply: '回覆',
  yes: '好',
  yesAnswer: '好，照做',
  no: '不要',
  noAnswer: '不要，先別做',
  noneOfThese: '都不是？打字回覆',
  copyCommand: '複製指令',
  didIt: '做好了',
  openLink: '打開來看',
  looksGood: '沒問題',
  looksGoodAnswer: '看過了，沒問題',
  whatToChange: '要改什麼？',
  ready: '好了',
  readyAnswer: '好了，可以繼續',
  replyPlaceholder: '回覆 Claude…',
  contextLine: (text: string): string => `背景：${text}`,
  continueElsewhere: (project: string): string => `到 ${project} 的對話接著做。`,
  heldElsewhere: '另一個對話正在做。',
  takeOver: '接手做完',
  copyResume: '複製續接指令',
  tickStep: '完成這步',
  handOver: '交給 Claude',
  nothingForYou: '✓ 現在沒有要你做的事',
  mostNeeded: '現在最需要你',
  stuckLead: '! 卡住',
  moreWaiting: (n: number): string => `還有 ${n} 件等你 ▸`,
  countWaiting: '等你',
  countActive: '進行中',
  countDue: '快到期',
  countToday: '今天完成',
  nowStep: (text: string): string => `▸ 現在：${text}`,
  nextStepLine: (text: string): string => `○ 下一步：${text}`,
  foldSteps: '▾ 收起步驟',
  allSteps: (n: number): string => `▸ 全部 ${n} 步`,
  noTaskTools: '這個對話沒有 Task 工具，進度不會自動同步。',
  noTaskToolsHow:
    '從終端機開的 claude：把 CLAUDE_CODE_ENABLE_TODO_TOOLS=1 加進 shell 的 profile（PowerShell 是 $PROFILE，重跑 setup 腳本就會加），開新視窗再啟動就會同步。別放 settings.json，那裡的 env 也會進桌面 app。',
  noTaskToolsManual: '桌面 app、git-bash 這類沒有它的對話，照常手動記在 progress.md。',
  empty: '目前沒有進行中的工作。',
  emptyHow: 'Claude 用 Task 清單開工後，這裡會自動出現；也可以在下面打「+ 專案：要做的事」自己加。',
  sectionWaiting: '等你處理',
  sectionDue: '快到期',
  nearestDue: (title: string, left: string): string => `最近：${title} ${left}`,
  sectionActive: '進行中',
  sectionOther: '其他進行中',
  thisProject: (name: string): string => `${name}（這個專案）`,
  sectionRecent: '最近完成',
  archiveNow: '現在封存',
  askPlaceholder: '問一句；+ 開頭就新增一件事',
  send: '送出',
  question: (text: string): string => `問：${text}`,
  thinking: '想一下…',
  copied: '已複製到剪貼簿',
  clear: '清掉',
  report: '週報',
  notifyOnButton: '通知：開',
  notifyOffButton: '通知：關',
  legend: '說明',
  legendClose: '收起說明',
  legendDue: '⚑ 兩週內截止',
  legendAsk: '〔確認〕好或不要 · 〔選一個〕按選項 · 〔填資料〕打字回覆 · 〔動手〕做完按做好了 · 〔看一下〕看完回覆 · 〔等別人〕到了再按',
  legendCleanup: '半天沒動靜的對話算已停。做完的工作半天後、停掉的三天後、手寫任務全打勾一天後，自動移到封存檔。',
  answered: (text: string): string => `已回覆 Claude：${text}`,
  commandOf: (step: string): string => `「${step}」要跑的指令`,
  resumeOf: (title: string): string => `回到「${title}」的指令，貼到終端機執行`,
  fileUnreadable: '讀不到進度檔',
  dashStamp: (time: string): string => `更新於 ${time}`,
  windowOpened: (path: string): string => `已在瀏覽器打開：${path}`,
  windowFailed: (path: string): string => `打不開瀏覽器，請自己開：${path}`,
}

export type Strings = typeof ZH_TW

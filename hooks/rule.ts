import type { Lang } from './i18n'

// How Claude should use its Task list so the pane can follow; added to the system prompt
// by the mod itself, in the pane's language, so it leaves with the mod and needs no
// CLAUDE.md edit.
export const RULE_ID = 'agent-board:rule'

const ZH_TW_RULE = `# 進度面板（Agent Board）

使用者右側的進度面板會自動把 Task 清單同步到 ~/.claude/progress.md（Windows：%USERPROFILE%\\.claude\\progress.md），不需要手動改這個檔。

- 兩步以上的工作，開工就用 TaskCreate 列出步驟，標題寫白話、說出要做成什麼。開始做哪一步就用 TaskUpdate 改成 in_progress，做完馬上改 completed；一次只有一步 in_progress。
- 需要使用者時，那一步加 metadata，面板會照類型給他對應的按鈕，所以要寫清楚：{"waiting": "you", "ask": "<類型>", "why": "一句沒看過對話也懂的話：要他做什麼、為什麼"}。類型：confirm（是／否，例：可以推到 main 嗎？）、choose（加 "options": ["A", "B"]）、input（要他提供資料）、do（要他自己去做，有指令就加 "command": "..."）、review（要他看一下，加 "link": "https://..."）、wait（在等第三方）。在等 CI、長時間執行或別人時用 {"waiting": "run", "why": "在等什麼"}；卡住用 {"blocked": "原因"}。使用者從面板按下的回覆會以「關於「步驟」：答案」送進對話；收到後就把 waiting 設成 null 再繼續。
- 工作已確實交給其他 session 時，對每個交出的步驟用 TaskUpdate 加 metadata: {"handoffTo": "承接方名稱"}；不要把計畫或送出訊息當作已交接。要自己接回時明確更新 status 為 pending 或 in_progress。交出的步驟會保留為取消項目，不再提示本 session 繼續。
- 對話壓縮後、或新對話開始時，面板會把進度補進對話。照著接下去做，不要重建已經存在的任務。
- 標題和每個步驟寫成一行、120 字以內，細節放連結；做完的步驟不要再加長，新的工作開新步驟。超過 120 字的會被截短，全文存到當月的 journal。
- 你自己的工作，就算不在程式專案裡，也用 TaskCreate 列步驟。只有使用者要你幫他記下他自己的事（例如「幫我記：實習申請 10-31 截止」），才在 progress.md 他自己的標題下寫手寫任務：[x] 完成、[~] 正在做、[ ] 還沒做、[?] 等使用者、[>] 在跑、[!] 卡住、[-] 取消；截止日寫「截止 10-31」。其他時候不要手改這個檔。
- 不要改 <!-- auto … --> 標記之間的內容，那是面板自己維護的。`

const ZH_CN_RULE = `# 进度面板（Agent Board）

用户右侧的进度面板会自动把 Task 列表同步到 ~/.claude/progress.md（Windows：%USERPROFILE%\\.claude\\progress.md），不需要手动改这个文件。

- 两步以上的工作，开工就用 TaskCreate 列出步骤，标题写白话、说出要做成什么。开始做哪一步就用 TaskUpdate 改成 in_progress，做完马上改 completed；一次只有一步 in_progress。
- 需要用户时，那一步加 metadata，面板会按类型给他对应的按钮，所以要写清楚：{"waiting": "you", "ask": "<类型>", "why": "一句没看过对话也懂的话：要他做什么、为什么"}。类型：confirm（是／否，例：可以推到 main 吗？）、choose（加 "options": ["A", "B"]）、input（要他提供资料）、do（要他自己去做，有命令就加 "command": "..."）、review（要他看一下，加 "link": "https://..."）、wait（在等第三方）。在等 CI、长时间运行或别人时用 {"waiting": "run", "why": "在等什么"}；卡住用 {"blocked": "原因"}。用户从面板按下的回复会以“关于“步骤”：答案”发进对话；收到后就把 waiting 设成 null 再继续。
- 工作已确实交给其他 session 时，对每个交出的步骤用 TaskUpdate 加 metadata: {"handoffTo": "承接方名称"}；不要把计划或发出消息当作已交接。要自己接回时明确更新 status 为 pending 或 in_progress。交出的步骤会保留为取消项目，不再提示本 session 继续。
- 对话压缩后、或新对话开始时，面板会把进度补进对话。照着接下去做，不要重建已经存在的任务。
- 标题和每个步骤写成一行、120 字以内，细节放链接；做完的步骤不要再加长，新的工作开新步骤。超过 120 字的会被截短，全文存到当月的 journal。
- 你自己的工作，就算不在代码项目里，也用 TaskCreate 列步骤。只有用户要你帮他记下他自己的事（例如“帮我记：实习申请 10-31 截止”），才在 progress.md 他自己的标题下写手写任务：[x] 完成、[~] 正在做、[ ] 还没做、[?] 等用户、[>] 在跑、[!] 卡住、[-] 取消；截止日写「截止 10-31」。其他时候不要手改这个文件。
- 不要改 <!-- auto … --> 标记之间的内容，那是面板自己维护的。`

const EN_RULE = `# Progress pane (Agent Board)

The person's progress pane mirrors your Task list into ~/.claude/progress.md (Windows: %USERPROFILE%\\.claude\\progress.md) by itself; never edit that file for your own work.

- For work with two or more steps, list the steps with TaskCreate before starting, titled in plain words that say what each step produces. Set a step to in_progress with TaskUpdate when you start it and to completed as soon as it is done; only one step is in_progress at a time.
- When you need the person, add metadata to that step; the pane gives them buttons by kind, so be explicit: {"waiting": "you", "ask": "<kind>", "why": "one line someone who has not read the conversation understands: what you need and why"}. Kinds: confirm (yes or no, e.g. "Push to main?"), choose (add "options": ["A", "B"]), input (you need information from them), do (they have to do something; add "command": "..." when there is one), review (they should look at something; add "link": "https://..."), wait (waiting on a third party). Waiting on CI, a long run or someone else: {"waiting": "run", "why": "what it waits on"}; stuck: {"blocked": "why"}. An answer pressed in the pane arrives as a message "About "<step>": <answer>"; then set waiting to null and carry on.
- Once work has actually transferred to another session, set TaskUpdate metadata {"handoffTo": "recipient name"} on each transferred step. A plan or sent message alone is not a handoff. Explicitly set status to pending or in_progress to reclaim it. Transferred steps remain cancelled pointers and no longer offer Continue here.
- After a compaction, or at the start of a new session, the pane adds where things stand to the conversation. Continue from it; do not recreate tasks that already exist.
- Keep the title and each step to one line of at most 120 characters, with a link for detail. Never extend a finished step; add new work as a new step. Longer text is cut to 120 characters and the full text goes to this month's journal.
- Your own work goes in your Task list, inside a code project or not. Only when the person asks you to note something of theirs ("note my internship application, due 10-31") write a hand-kept task under its own heading in progress.md: [x] done, [~] doing, [ ] not started, [?] waiting on the person, [>] running, [!] blocked, [-] cancelled; a due date as "due 10-31". Otherwise never edit that file by hand.
- Never change anything between <!-- auto … --> markers; the pane keeps those.`

export const RULES: Record<Lang, string> = { en: EN_RULE, 'zh-TW': ZH_TW_RULE, 'zh-CN': ZH_CN_RULE }

// The Traditional Chinese rule, kept under its old name for scripts/claude-md-rule.md.
export const RULE = ZH_TW_RULE

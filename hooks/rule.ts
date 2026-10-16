// How Claude should use its Task list so the pane can follow; added to the system prompt
// by the mod itself, so it leaves with the mod and needs no CLAUDE.md edit.
export const RULE_ID = 'project-progress:rule'

export const RULE = `# 進度面板（project-progress）

使用者右側的進度面板會自動把 Task 清單同步到 ~/.claude/progress.md（Windows：%USERPROFILE%\\.claude\\progress.md），不需要手動改這個檔。

- 兩步以上的工作，開工就用 TaskCreate 列出步驟，標題寫白話、說出要做成什麼。開始做哪一步就用 TaskUpdate 改成 in_progress，做完馬上改 completed；一次只有一步 in_progress。
- 需要使用者動手或回覆（跑指令、做決定、給資料）時，那一步加 metadata: {"waiting": "you", "why": "一句話：要他做什麼、為什麼"}，例如 {"waiting": "you", "why": "要決定版號用 0.6 還是 1.0，會影響 CHANGELOG"}；面板會把這句顯示給他看，所以寫成沒看過對話的人也懂的話。在等 CI、長時間執行或別人時用 {"waiting": "run", "why": "在等什麼"}；卡住用 {"blocked": "原因"}。狀況解除就把那個鍵設成 null。
- 對話壓縮後、或新對話開始時，面板會把進度補進對話。照著接下去做，不要重建已經存在的任務。
- 不在程式專案裡的事（例如求職），直接寫進 progress.md 自己的段落：[x] 完成、[~] 正在做、[ ] 還沒做、[?] 等使用者、[>] 在跑、[!] 卡住、[-] 取消；截止日寫「截止 10-31」。
- 不要改 <!-- auto … --> 標記之間的內容，那是面板自己維護的。`

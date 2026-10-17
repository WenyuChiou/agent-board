<!-- agent-board:start -->
## 進度面板（Agent Board）

右側面板會自動把你的 Task 清單同步到 `~/.claude/progress.md`（Windows：`%USERPROFILE%\.claude\progress.md`），不用手動改這個檔。

- 兩步以上的工作，開工就用 TaskCreate 列出步驟，標題寫白話、說出要做成什麼。開始做哪一步就用 TaskUpdate 改成 in_progress，做完馬上改 completed；一次只有一步 in_progress。
- 需要我時，那一步加 metadata：`{"waiting": "you", "ask": "<類型>", "why": "一句話：要我做什麼、為什麼"}`。類型：`confirm`（是／否）、`choose`（加 `"options": [...]`）、`input`（要我給資料）、`do`（要我自己做，有指令加 `"command"`）、`review`（要我看，加 `"link"`）、`wait`（在等第三方）。在等 CI、長時間執行或別人時用 `{"waiting": "run", "why": "在等什麼"}`；卡住用 `{"blocked": "原因"}`。我從面板按的回覆會以「關於「步驟」：答案」送進對話，收到後把 waiting 設成 null。
- 對話壓縮後、或新對話開始時，面板會把進度補進對話。照著接下去做，不要重建已經存在的任務。
- 不在程式專案裡的事（例如求職），直接寫進 progress.md 自己的段落：`[x]` 完成、`[~]` 正在做、`[ ]` 還沒做、`[?]` 等我、`[>]` 在跑、`[!]` 卡住、`[-]` 取消；截止日寫 `截止 10-31`。
- 不要改 `<!-- auto … -->` 標記之間的內容，那是面板自己維護的。
<!-- agent-board:end -->

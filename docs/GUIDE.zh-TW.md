# 使用指南

[English](GUIDE.md) · 繁體中文 · [简体中文](GUIDE.zh-CN.md) · [README](../README.zh-TW.md)

## 開始使用

工作交出後由來源明確回報：Claude Task 工具在每個交出的步驟加 `metadata: {"handoffTo":"承接方名稱"}`；明確改為 pending／in_progress 可接回。回合摘要用 `HANDOFF` 記錄承接方，`NEXT` 保留交出的工作；其他 reporter 寫 `[-] 工作 — 已交給承接方`。來源保留取消項目，不再提示 Continue，也不重複計入承接方的工作。交接計畫、送出訊息、模型摘要或進度更新都不證明送達，也不批准動作。

使用 Node.js 18+ 與 repository checkout。永久變更先預覽、核准再套用：

```sh
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

自動偵測辨識 host 設定，不代表 session 在線。尚無設定的已知 host 可用 `--agent <name>`；`--agent all` 預覽全部目標，不會安裝 AI 應用程式。[安裝說明](SETUP.md)列出路徑與 adapter 範圍。

新獨立安裝使用 `~/.agent-board/progress.md`，既有安裝保留原檔；`--progress-file /absolute/path/progress.md` 可明確指定。一般本機安裝不需選另一台電腦的看板。

讀回定義，完成 host 的信任／啟用。Codex 可在使用者核准後執行限定信任，詳見 [Codex](CODEX.md)。已開啟的 session 可能需要重新載入。CLI、桌面 App、IDE 各自驗收。

## 其他 agent

共用安裝器寫入看板、skill 及已實作的原生 adapter，不需要 Claude Code 或另一個模型。[支援範圍](SETUP.md#native-status-adapters)會區分已安裝與待實作項目。

支援的提示 hook 會在下次收件匣輪詢時，把既有 agent 的問題標為已回答並切回工作中，不呼叫模型。舊版收件匣事件若來源時間較舊、相同、不明或無效，就不更動，也不建立或還原區塊。回執必須讀回確認才移除收件匣輸入，失敗會保留重試。`/progress connect` 更新 hooks，`connect remove` 一併移除；OpenClaw 必須由 host 明確標示 `external_user` 來源。[提示事件契約與檢查](validation/2026-10-19-prompt-hooks.md)列出支援範圍及限制。

唯讀預覽會略過提示中繼資料，保留尚未整理的回報與問題。單憑提示時間或檔案修改時間，不能證明回報已處理。

OpenClaw、DeepSeek Harness 已有獨立狀態 plugin 與原生 skill；Grok 新提示會切回工作中，OpenCode 遵循設定目錄覆寫。[跨 host 驗收](validation/2026-10-19-portable-hosts.md)區分隔離回呼／SDK 檢查與未執行的原生測試。hooks 不會安裝收訊通道；接到同一私有訊息目錄的 agent 共用回執與去重紀錄，任務封存不會清掉訊息 ID。

原生 hooks 回報活動，不推測任務步驟。Codex Stop、Antigravity Stop 代表等待下一回合，不是對話關閉或任務完成。原生新提示／啟動會重新啟用同一區塊。任務標題、步驟、阻擋及完成由 agent 明確回報，且只能綁定自身可證明的 session。缺少 host context 時，不猜 ID、不讀對話來湊回報。

舊進度卡片不能證明程序仍在執行；應用程式開著，也不能證明該 session 已載入 hooks 或註冊傳訊 adapter。[原生驗收紀錄](validation/2026-10-19-native-hooks.md)分別記錄這些能力。

## 每個 agent 裡都看得到看板

使用已安裝的 skill，或安裝器印出的確切程式路徑：

```sh
node ~/.agent-board/agent-board.mjs --serve
node ~/.agent-board/agent-board.mjs --watch
node ~/.agent-board/agent-board.mjs --chat
node ~/.agent-board/agent-board.mjs --html
```

| 模式 | 結果 |
| --- | --- |
| `--serve` | 互動網頁與可重用的本機背景服務 |
| `--watch` | 終端看板：方向鍵／Enter 選取，`x` 勾選，`d` 確認完成，`a` 封存，`h` 隱藏，`u` 還原，`i` 閒置工作，`c` 複製，`o` HTML，`q` 離開 |
| `--chat` | 精簡文字；不開網頁、連結或瀏覽器、不寫檔 |
| `--html` | 產生並開啟唯讀網頁，不能傳訊 |

聊天模式先列問題，再列尚未整理的進度回報與來源時間。回報不代表工作完成或連線在線；已取走或處理的收件檔不會重複顯示，也不會只因 hook 時間更新就隱藏待處理回報。超長內容會顯示省略數量，聊天模式不寫檔。

加上 `--lang en`、`zh-TW` 或 `zh-CN` 選擇語言。Windows／自訂安裝請使用實際印出的完整路徑。Codex 的入口是 `$agent-board`，OpenCode 安裝 `/board`；其他 host 須先載入已安裝的 skill／command。

### 看板的網頁

已隱藏的同一問題不會因其他步驟移動或空白變動而重現。相同文字的問題各有識別；數量改變時無法確定對應，因此會重新顯示，不會繼承另一題的隱藏標記。看板觀察到問題已解決或移除後，再次提出會得到新的識別；若報告直接以完全相同的文字重新提問、沒有可觀察的狀態變化，看板無法推斷這次更新。仍可使用「重新顯示」。隱藏不代表回答、核准、完成或訊息送達。

Claude 明確再次提問時，即使文字相同，也會更新該問題的識別，不需等中間的重新整理。進度檔會隨該步驟保留一個修訂註記，看板不顯示這項 metadata；其他已隱藏的問題與無關更新維持原識別。上述觀察限制僅適用於既無狀態轉換、也無提問來源修訂訊號的報告。

本機識別紀錄存於 `progress.md` 旁的 `progress-questions.json`，與 `progress-answered.json` 分開；搬移看板時請保留兩者。舊的依位置標記會在完整報告穩定後遷移，僅保留同一範圍內正規化文字唯一相符的問題；重複或無法對應的原始標記仍保留，但不隱藏未來的新問題。遷移標記可避免識別檔的寫入遺失後錯用舊標記。識別檔損壞或無法寫入時保留原檔，新的隱藏操作會顯示失敗。聊天與單次讀取不寫遷移檔；未答問題在恰好三天內維持顯示；超過三天到恰好七天改為一組提醒，超過七天移出可處理計數，仍可在「更早、尚未回答的問題」展開查看完整來源與時間。查看不會重設問題時間。終端按 `l` 查看較早問題，純文字使用 `--all`。手動、自己的 session、已停外部 session 與收件匣問題共用政策。時間從持久保存的首次觀察開始，不用心跳或匯入時間；未知或未來的觀察時間保守維持顯示。唯讀聊天與單次讀取使用既有基準，不建立基準。

備份或搬移時也請保留 `progress-questions-retired-*.json` 與 `progress-questions-consumed-*.json`。這些不可變紀錄只含版本、種類與不透明雜湊，避免舊檔案寫入讓已退役的識別或已遷移的隱藏標記復活。它們不隨時間或工作封存而刪除。紀錄無法讀取、不完整或無法寫入時，先停用隱藏直到儲存恢復；寧可多顯示問題，也不錯用舊標記。

側欄、終端和網頁以任務與 agent 辨識工作，不顯示連線清單或對話 ID；有支援的續接命令只在操作時複製。

問題排最前面，展開工作可看步驟。可勾選手動步驟、封存、貼入有效區塊、複製回覆或續接命令、標記已讀及還原。已讀只改本機隱藏清單，不傳話；實質不同的新問題會再出現。目前沒有通用任務編輯表單。

**確認完成**一次勾選所有未完成步驟，保留已取消步驟。即使尚無來源快取，後續 prompt 更新也保留這些取消項目；來源的新報告可取代該快照。可按側欄／網頁按鈕，或在終端選取工作後按 `d`。僅適用手動工作，以及已結束或超過 12 小時未寫入的 agent 區塊；工作已變動或仍在執行時會拒絕。每個新勾選都記入日誌；區塊會設為 `state=done` 並更新時間，再依原有等待期封存。不向 agent 傳話，`progress.html` 仍唯讀。

本機後續狀態更新會保留已完成步驟；新的明確工作回報仍可帶入新工作。

貼入進度保留來源時間。重複內容不變更；較舊或同時間衝突的進度會拒絕。無效或超前的時鐘須先修正；原有進度時間不明時，須比較兩份內容後確認取代。修復方式見[遠端回報](REMOTE_REPORTERS.md)。

卡片只有在確切 session 的 adapter 在線時提供傳送，否則複製或自行開啟 agent。[傳訊說明](MESSAGING.md)區分設定、真正回覆、重複、衝突及逾時。安裝不會任意接管已開啟的對話，一般回覆也不能批准工具、信任或 PR 合併。

`--no-open` 只印出網址，不開瀏覽器。關分頁不會停止本機服務，再執行同一 `--serve` 即可重開。**關閉看板**才會停止；若正在送訊，請等完成。預設不會閒置關閉，`--idle-minutes 30` 才啟用。舊版 `--allow-resume` 會明確啟用已結束 Codex／Grok 的重新啟動，預設關閉，也不會用作即時通訊的回退路徑。

#### 在手機上

網頁的版面適合手機。要從和電腦連同一個 Wi-Fi 的手機打開，跑 `node ~/.agent-board/agent-board.mjs --serve --lan`：除了電腦本機的網址，它還會印出網頁在你網路上的網址和它的 QR code，用手機相機對著掃就好。電腦有不只一個網路位址時，用 `--lan 192.168.1.23` 指定一個。Windows 可能會問要不要讓 Node.js 使用網路：在私人網路上允許，並確認 Windows 把你的 Wi-Fi 算成私人網路（剛連上的網路它會先當成公用網路），不然手機連不到網頁。跨網路存取須另行設定遠端連線。

網路上的網頁有這些限制：

- 只有加了 `--lan` 才開，只開在電腦的私人位址上（開頭是 192.168、10，或 172.16 到 172.31 的位址，絕不是公開位址），也只回應送到那個位址的請求。
- 它的網址帶著自己的一把鑰匙，不是電腦本機網頁那把。拿到這個網址或拍到 QR code 的人，在它關掉之前都能用這個網頁，所以只在信得過的網路上用，例如家裡的 Wi-Fi，不要在咖啡店的。
- 在網路上，網頁走的是沒有加密的 HTTP，同一個 Wi-Fi 上的其他裝置可能讀得到傳過去的內容，包括 agent 的回答。所以手機可以勾步驟、封存、標成已回覆（和重新顯示）、複製、貼上區塊和關閉看板，但不能回覆 agent：回覆會在電腦上跑一個程式，所以手機只顯示答案讓你複製，再從電腦本機的網頁送出。
- 10 分鐘沒有手機來看就會關，電腦本機的網頁關掉時也跟著關。開著的時候再跑一次 `--serve --lan`，拿到的是同一個網址。

開放前請讀[安全說明](../SECURITY.md)。

## 進度檔

`progress.md` 是儲存資料，不是 UI。每個 agent 擁有自己的區塊，不覆寫其他 session。格式支援英、繁中、簡中關鍵字，標記、所有權與寫入讀回規則見 [FORMAT](FORMAT.md)。

共用檔案不會自動跨機同步。[遠端回報](REMOTE_REPORTERS.md)是另行選用的流程。`dot` 標籤或貼上的區塊不能證明真正 dot 已連線。

## 選用 Claude Code 側欄

需要 Claude Code 2.1.287+；離線 CI 使用 2.1.301：

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

開啟新 Claude Code session，使用 `/progress`。側欄鏡像 Task 工具，也可透過它的模型整理回合。問題與決策顯示於任務上方；側欄跟隨 Claude 主題，瀏覽器跟隨系統主題。

Claude 桌面應用程式會顯示底部狀態列；`/progress` 會在瀏覽器開啟唯讀看板網頁。Claude Code CLI 則顯示側欄。

| 指令／輸入 | 操作 |
| --- | --- |
| `/progress connect`、`connect status`、`connect remove` | 選用 plugin 連接、上次狀態、移除 |
| `+ 求職: 研究駐點 截止 11-20; 草稿; 送出` | 側欄快速新增，也可用 `/progress add …` |
| `/progress open` | 產生並開啟唯讀 `progress.html` |
| `/progress tidy`、`/progress sync` | 封存符合條件工作；重讀 Task／PR |
| `/progress report`、`/progress today` | 複製週報／日報 |
| `/progress lang en`、`zh-TW`、`zh-CN`、`auto` | 側欄語言 |
| `/progress notify on`、`off` | 桌面通知 |

選用連接器需要 Node.js 18+；遷移前請重新載入較舊的 plugin 工作階段。原生 worker 跨資料目錄共用安裝鎖，持續記住移除停用意圖，並保留外部修改。側欄與輪詢先啟動，版本檢查在背景進行；缺少 Node 或設定記錄損壞時不修改設定。`connect status` 表示設定結果，不證明原生執行。

選用的 `scripts/setup.sh`／`scripts/setup.ps1` 處理 Claude 專用 Task 工具／profile 與 marketplace 設定。修改 profile 前先檢查範圍；獨立安裝不需要這些腳本。舊 plugin inbox 連接器可保留對話資料並呼叫 Claude 整理，和只記活動 metadata 的獨立 hooks 不同。[安全說明](../SECURITY.md)。

## 它怎麼保持整齊

選用側欄在 session 開始與每小時清理：完成區塊等 12 小時，其他已停／過時區塊等三天，已觀察完成的手動工作等 24 小時。明確整理可跳過完成工作的等待。工作中或等待中的 agent 區塊，最後寫入後 12 小時內仍算執行中；側欄、終端與網頁會說明暫不能封存，整理也會保留。停止或結束後，展開工作即可立即封存。 自動整理保留仍有 `[?]` 的區塊。明確封存前也必須保存並讀回完整問題快照，來源移走後仍可找回；儲存失敗便保留來源。

超過 12 小時沒回報的卡片可能顯示已停，這是資料過時判斷，不是原生程序檢查；真正新事件／回報會刷新。超過七天沒動的工作折疊，不修改區塊；`--all` 或閒置開關可展開，快到期的工作保留顯示。已結束或過時的對話會移至獨立的已停止區，不再計入進行中；未回答的問題仍留在等你處理，`--all` 或 `i` 可展開閒置和已停止工作。

## 更新與移除

獨立安裝：將乾淨 checkout 更新到指定版本，預覽 `node scripts/setup-agent.mjs`，再套用已核准範圍。修改過的檔案列為衝突，不覆寫。host 可能要重新載入；不安裝自動更新器或開機服務。

用已安裝程式預覽／套用目標移除：

```sh
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>
node ~/.agent-board/agent-board.mjs --codex-remove --agent <name> --apply
```

`--codex-remove`、`--codex-doctor` 是沿用的維護名稱，可搭配各目標。先關閉該看板。只移除未修改的自有定義／檔案；其他目標還需要的共用檔案保留，進度、session 紀錄、封存、日誌及使用者修改也保留。

選用 plugin 請先在仍安裝時執行 `/progress connect remove`，完成回報的清理後，再執行 `claude plugin uninstall agent-board@agent-board`；marketplace 用 `claude plugin marketplace remove agent-board` 移除。更新用 `claude plugin marketplace update agent-board`、`claude plugin update agent-board@agent-board`，之後重新載入 plugin。

### 從舊名稱換過來

0.10 前的選用 plugin 名稱是 `project-progress@claude-progress-pane`。移除舊 plugin／marketplace，安裝上方新名稱；若使用其連接器，再於 Claude Code 內執行 `/progress connect`。保留原進度檔。獨立安裝不需要 Claude 遷移。

## 疑難排解

- **沒卡片：** 檢查路徑、adapter、信任與重新載入；觀察真正事件並讀回確切 session 區塊，不手動製造事件宣稱通過。
- **不能傳送：** 確切原生 session 需要受支援的在線 adapter，hooks 本身不等於可收訊，桌面與 CLI 結果不可互代。
- **接線轉述被忽略：** 接收者應告知授權或阻擋原因；RPC 成功或 ACK 不等於已觀察到新進度。
- **讀寫失敗：** 處理指出的檔案／權限問題，檢查進度與歷史再重試；不先確認 owner 就刪鎖。
- **沒有原生側欄：** 非 Claude host 使用互動網頁或終端看板，網頁面板不等於原生側欄。

### 安全地回報問題

提供 Agent Board／host 版本、CLI／App／IDE、OS 與合成重現資料；只有選用 plugin 才需要 Claude 版本。不上傳原始進度、inbox、封存、日誌、session log、憑證或看板 token。[安全回報](../SECURITY.md#reporting-a-problem)。

目前 Codex hooks 尚未在 /hooks 核准時，選用連接器會保留受管理的回報指示；信任未知或失效會在 connect 恢復。status 查詢信任，但不修改指示。

完整來源也保存在看板旁、依內容定址的 progress-questions-source-*.json 檔案。備份或搬移時請保留整組 questions 檔案；證據檔不依年齡刪除。每次讀取都合併所有副本，過期索引無法刪掉原始來源。清理與明確封存前必須成功寫入並讀回完整副本。end 事件只關閉連線，不代表回答問題；同一來源的多個問題與僅出現在 end 的問題都保留。副本損壞或無法讀取時，拒絕清理來源與新的隱藏操作。
處理與解決後仍保留精確來源版本，因此重播舊的原始檔不會把已回答問題當作新問題；新的來源版本仍可被辨識。
明確封存會把完整未答副本保留在較早問題區；來源意外消失時仍沿用正常年齡政策，未知時間的問題維持顯示。
過期報告若仍使用相同的已知來源版本與問題文字，不會讓已解決問題重新出現。明確更新來源版本或實質改變問題文字後，問題仍可再次顯示。
終端與原生面板的提醒／較早問題區，仍有來源的問題可按「已回覆，先隱藏」及「再次顯示」，不會變更來源或重設時間。來源已消失的保留副本會標明僅供查看；網頁的提醒／較早問題區也僅供查看，不提供隱藏按鈕。
原生面板的回覆若送出失敗或被拒絕，問題維持未讀。成功送出後仍會核對精確問題與來源；傳送期間重新提出的問題不會被標成已讀。既有問題移至保留區不會產生新通知。

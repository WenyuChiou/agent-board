# 使用指南

[English](GUIDE.md) · 繁體中文 · [简体中文](GUIDE.zh-CN.md) · [README](../README.zh-TW.md)

## 開始使用

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
| `--watch` | 終端看板：方向鍵／Enter 選取，`x` 勾選，`a` 封存，`h` 隱藏，`u` 還原，`i` 閒置工作，`c` 複製，`o` HTML，`q` 離開 |
| `--chat` | 精簡文字；不開網頁、連結或瀏覽器、不寫檔 |
| `--html` | 產生並開啟唯讀網頁，不能傳訊 |

加上 `--lang en`、`zh-TW` 或 `zh-CN` 選擇語言。Windows／自訂安裝請使用實際印出的完整路徑。Codex 的入口是 `$agent-board`，OpenCode 安裝 `/board`；其他 host 須先載入已安裝的 skill／command。

### 看板的網頁

側欄、終端和網頁以任務與 agent 辨識工作，不顯示連線清單或對話 ID；有支援的續接命令只在操作時複製。

問題排最前面，展開工作可看步驟。可勾選手動步驟、封存、貼入有效區塊、複製回覆或續接命令、標記已讀及還原。已讀只改本機隱藏清單，不傳話；問題文字改變後會再出現。目前沒有通用任務編輯表單。

貼入進度保留來源時間。重複內容不變更；較舊或同時間衝突的進度會拒絕。無效或超前的時鐘須先修正；原有進度時間不明時，須比較兩份內容後確認取代。修復方式見[遠端回報](REMOTE_REPORTERS.md)。

卡片只有在確切 session 的 adapter 在線時提供傳送，否則複製或自行開啟 agent。[傳訊說明](MESSAGING.md)區分設定、真正回覆、重複、衝突及逾時。安裝不會任意接管已開啟的對話，一般回覆也不能批准工具、信任或 PR 合併。

關分頁不會停止本機服務，再執行同一 `--serve` 即可重開。**關閉看板**才會停止；若正在送訊，請等完成。預設不會閒置關閉，`--idle-minutes 30` 才啟用。舊版 `--allow-resume` 會明確啟用已結束 Codex／Grok 的重新啟動，預設關閉，也不會用作即時通訊的回退路徑。

`--lan` 為選用功能：私人網路上另一個含 token 的 HTTP 連結，不允許 agent 傳訊，閒置 10 分鐘關閉該監聽器；仍可修改看板檔案。token 不會加密，開放前請讀[安全說明](../SECURITY.md)。

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

| 指令／輸入 | 操作 |
| --- | --- |
| `/progress connect`、`connect status`、`connect remove` | 選用 plugin 連接、上次狀態、移除 |
| `+ 求職: 研究駐點 截止 11-20; 草稿; 送出` | 側欄快速新增，也可用 `/progress add …` |
| `/progress open` | 產生並開啟唯讀 `progress.html` |
| `/progress tidy`、`/progress sync` | 封存符合條件工作；重讀 Task／PR |
| `/progress report`、`/progress today` | 複製週報／日報 |
| `/progress lang en`、`zh-TW`、`zh-CN`、`auto` | 側欄語言 |
| `/progress notify on`、`off` | 桌面通知 |

選用的 `scripts/setup.sh`／`scripts/setup.ps1` 處理 Claude 專用 Task 工具／profile 與 marketplace 設定。修改 profile 前先檢查範圍；獨立安裝不需要這些腳本。舊 plugin inbox 連接器可保留對話資料並呼叫 Claude 整理，和只記活動 metadata 的獨立 hooks 不同。[安全說明](../SECURITY.md)。

## 它怎麼保持整齊

選用側欄在 session 開始與每小時清理：完成區塊等 12 小時，其他已停／過時區塊等三天，已觀察完成的手動工作等 24 小時。明確整理可跳過完成工作的等待。獨立看板仍有封存操作。

超過 12 小時沒回報的卡片可能顯示已停，這是資料過時判斷，不是原生程序檢查；真正新事件／回報會刷新。超過七天沒動的工作折疊，不修改區塊；`--all` 或閒置開關可展開，快到期的工作保留顯示。

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

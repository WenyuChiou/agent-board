<h1 align="center">
<img alt="簡短導覽：五個 agent，其中一個在等你；直接在面板回答；每個 agent 透過自己的 hook 回報；什麼都不會漏；在哪裡用；淺色深色兩種配色。" src="docs/images/tour-zh-TW.svg" width="100%">
</h1>

<p align="center">
<b>每個 AI coding agent 在做什麼，一個面板看完；等你的事，永遠排第一個。</b><br>
本機互動看板，從你正在使用的 agent 開始；Claude Code 原生側欄是選用功能。各 host 能力見<a href="#支援的-agent">下方</a>。
</p>

<p align="center">
<a href="CHANGELOG.md"><img alt="版本 0.23.5" src="https://img.shields.io/badge/version-0.23.5-blue"></a>
<a href="#快速開始"><img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933"></a>
<a href="LICENSE"><img alt="MIT 授權" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS、Linux、Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>
<p align="center">
<a href="#支援的-agent"><img alt="Codex 0.163.0，依介面分開驗收" src="https://img.shields.io/badge/Codex-0.163.0-brightgreen"></a>
<a href="#支援的-agent"><img alt="Antigravity CLI native hooks" src="https://img.shields.io/badge/Antigravity%20CLI-native%20hooks-yellowgreen"></a>
<a href="#支援的-agent"><img alt="OpenCode 1.19.3，依介面分開驗收" src="https://img.shields.io/badge/OpenCode-1.19.3-brightgreen"></a>
<a href="#支援的-agent"><img alt="Grok Build 1.0.62，部分可用" src="https://img.shields.io/badge/Grok%20Build-1.0.62-yellowgreen"></a>
<a href="#支援的-agent"><img alt="Hermes Agent 0.19.0，部分可用" src="https://img.shields.io/badge/Hermes%20Agent-0.19.0-yellowgreen"></a>
<a href="#支援的-agent"><img alt="OpenClaw 2026.10.4，部分可用" src="https://img.shields.io/badge/OpenClaw-2026.10.4-yellowgreen"></a>
</p>

<p align="center"><a href="README.md">English</a> · 繁體中文 · <a href="README.zh-CN.md">简体中文</a></p>

你在一個專案開 Claude Code，另一個開 Codex，第三個開 Antigravity。二十分鐘後，其中一個停下來問你事情，你要等到剛好切回去才會發現。**Agent Board** 在它一開口就把問題放到你眼前，每個答案一個按鈕。

## 功能

- **需要你的事排最前面。** 任何 agent 的問題都放在最上面，每個答案一個按鈕。已連線的 agent 可直接傳送答案；其他情況則複製到原對話。已經在對話裡回過了？按**已回覆，先隱藏**，只在這台電腦上收起來，不會送出任何話；那個對話問了新的問題，它會再出現。
- **所有 agent 一處看。** 各 session 明確回報真實任務步驟，支援的原生 hooks 回報活動狀態；依專案分組，不讀私人對話。
- **隨時接著做。** 對話壓縮、終端機關掉、隔天早上都沒關係：做完什麼、卡在哪、下一步是什麼，打開就看到。做到一半停掉的對話，按一下就能接手。
- **你自己的待辦也放得進來。** 在面板的輸入框打 `+ 求職：Fabrikam 研究員 截止 11-20`。快到期會變黃，到期會變紅。
- **不在終端機也看得到。** `/progress open` 在瀏覽器打開同一個畫面（手機也行）；其他 agent 會打開[可以點的網頁](#看板的網頁)，在上面勾步驟、封存、回答。面板關著時，狀態列和桌面通知會告訴你有事在等你。
- **週報。** `/progress report` 和 `/progress today` 把做完的事複製成文字。
- **自己收拾。** 做完的事移到每月封存檔，日誌留下每一步完成紀錄。超過一週沒人動的工作收進一行 **N 項超過 7 天沒動**，檔案裡一字不改。
- **就是一個 Markdown 檔。** 獨立安裝預設用 `~/.agent-board/progress.md`，既有安裝沿用原路徑；你可以自己看、自己改。支援 English、繁體中文、简体中文；淺色深色都有。

## 怎麼運作

<img alt="Claude Code 對話、透過 hook 的其他 agent、和你，都寫進同一個 Markdown 檔 progress.md；面板、progress.html、封存與狀態列都讀它。" src="docs/images/flow-zh-TW.svg" width="100%">

獨立 reporter 將原生 session 活動與明確任務摘要寫到同一個本機 `progress.md`，每個 session 只更新自己的區塊；網頁看板不需要另一個模型。上圖是選用 Claude 外掛的 inbox 與摘要流程。格式見 [docs/FORMAT.md](docs/FORMAT.md)。

## 快速開始

<details open>
<summary><b>讓 agent 幫你安裝</b></summary>

把下面這段貼給你正在用的 agent，不必先選哪一家的安裝路線：

```text
幫我在這台電腦安裝 https://github.com/WenyuChiou/agent-board 的 Agent Board。
先讀 AGENTS.md、README 與安裝指南，辨識目前的 host 和這台電腦已安裝的其他 coding agent，再用共同入口 node scripts/setup-agent.mjs 預覽。
保留既有設定與共用進度路徑，依我對永久改動的確認要求，完成適用的 hooks、plugin 與看板入口；不要依賴或呼叫另一家 AI 來初始化。
完成原生 host 必要的限定範圍信任並讀回設定，讓目前 session 回報自己的真實任務進度，開啟互動看板。
CLI、桌面 App、IDE 的實際 hook 事件分開驗收；安裝檔案、傳輸接受、收到 ACK 和進度接通是不同結果。
列出哪些既有 session 需要重新載入，以及尚未支援或未驗收的部分。不要掃描私密對話，也不要默默略過阻擋。
```

</details>

手動安裝只需要 Node.js 18 以上與 Git。先預覽，再套用已檢查的安裝範圍：

```sh
git clone https://github.com/WenyuChiou/agent-board.git
cd agent-board
node scripts/setup-agent.mjs
node scripts/setup-agent.mjs --apply
```

安裝器偵測的是設定目錄，不代表那些 agent 正在執行。安裝後用看板 skill 開啟互動頁面；關掉分頁後可用 `node ~/.agent-board/agent-board.mjs --serve` 再開啟。見[共用安裝指南](docs/SETUP.md)。

<details>
<summary>Claude Code 原生側欄（選用）</summary>

需要 Claude Code 2.1.287 以上；離線 CI 使用 2.1.301。安裝外掛後開啟 Claude Code，輸入 `/progress`；其他 host 可獨立使用互動看板。

```sh
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

</details>

## 支援的 agent

獨立 hooks 與明確進度回報共用本機看板。卡片只透過確切在線 adapter 傳送；CLI、App、IDE 分開驗收。[傳訊說明](docs/MESSAGING.md)。

| Host／介面 | 目前範圍 |
| --- | --- |
| Codex CLI | 獨立安裝與六個 hooks；已驗證獨佔 app-server 的 hooks／ACK，互動 TTY 另行驗收。 |
| Codex 桌面 App | 互動看板與真實進度回報；原生自動 hooks、直接傳訊尚未驗收。 |
| Antigravity CLI | 獨立安裝、四個原生 hooks 與獨佔 stream 傳訊，已在 Windows 實測。App／IDE 另行驗收。 |
| Cursor、OpenCode、Grok Build、Muse Code | 可產生獨立 hooks 或 plugin；原生執行與收訊依 host 而異，不能只憑安裝判定通過。 |
| OpenClaw、DeepSeek Harness | 獨立原生狀態 plugin 與 skill；隔離回呼／載入檢查通過。原生應用程式及收訊仍未驗收。 |
| Hermes Agent | 看板與 skill；獨立生命週期 adapter 待完成。 |
| Claude Code | 選用原生側欄、Task 鏡像與 plugin 連接流程。 |
| dot 與其他網頁 agent | 明確進度轉送；尚未驗證原生收訊。 |

### 依能力

生命週期支援見[安裝 adapter 表](docs/SETUP.md#native-status-adapters)；精確 session 綁定、ACK 與介面限制見[傳訊文件](docs/MESSAGING.md)。

<details>
<summary>舊 Gemini CLI 相容性</summary>

Google 已於 2026 年 6 月 18 日停止 Gemini CLI 的免費個人版及 Google AI Pro／Ultra 服務，改用 Antigravity CLI；企業授權與付費 API key 管道另計。保留明確指定的 `--agent gemini` 相容目標，不把它當成 Antigravity 的別名。[官方公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)。

</details>

<details>
<summary>選用 Claude connector 的歷史截圖</summary>

這張歷史圖片含舊 Gemini CLI；目前一般使用者入口改為 Antigravity CLI，圖片不算 Antigravity 驗收證據。

<img alt="看板列出 6 家 agent 各自問的問題：Codex、Gemini CLI、OpenClaw、OpenCode、Grok Build、Hermes Agent" src="docs/images/live/hooks-zh-TW.png" width="620">

</details>

## 每個 agent 裡都看得到看板

接上時，每個 agent 也會拿到一個看看板的指令。不管你在哪一個裡面，都看得到全部 agent 在做什麼：

| 在 | 打 |
|---|---|
| OpenCode | `/board` |
| Codex | `$agent-board` |
| OpenClaw、Hermes Agent | `/agent-board` |
| Grok Build、Cursor、Antigravity（還沒驗證） | `/agent-board` |
| 任何終端機，開在任何 agent 旁邊 | `node ~/.agent-board/agent-board.mjs --watch`（`--html` 在瀏覽器開） |
| 瀏覽器，從任何 agent | `node ~/.agent-board/agent-board.mjs --serve` |
| 聊天軟體，透過 agent（Hermes Agent、OpenClaw） | `node ~/.agent-board/agent-board.mjs --chat`（純文字，沒有網頁也沒有網址；由 agent 去跑） |

**在聊天軟體裡。** `--chat` 把看板印成純文字，沒有網頁、沒有網址、也不開瀏覽器，並縮到一則訊息放得下（還有更多時結尾是「還有 N 項」）。等你回覆的問題排最前面，接著是每件工作和它的下一步，最後是今天做完的。它會把你的家目錄顯示成 `~`，並遮掉它認得的憑證形式（例如 `token=...`、`Bearer ...` 和常見的金鑰開頭）；其他形狀的機密它認不出來，所以別把機密寫進看板。Hermes Agent 的 skill 會替你執行它，並把印出來的內容原樣送出。

**像面板一樣操作。** 在 agent 旁邊開一個終端機（分割視窗），執行 `node ~/.agent-board/agent-board.mjs --watch`：

| 按鍵 | 作用 |
|---|---|
| ↑ ↓、Enter | 選一行、展開 |
| `x` | 勾掉自己工作的下一步，並記進工作日誌 |
| `a` | 封存自己的工作，或已停對話的區塊 |
| `1`–`9`、`y`／`n` | 複製另一個 agent 問題的答案，貼到那個 agent |
| `c` | 複製指令，或接回提問那個對話的指令 |
| `h`、`u` | 把另一個 agent 的問題標成已回覆：只在這台電腦上隱藏，不送出任何話；把隱藏的全部重新顯示 |
| `i` | 展開或收起超過 7 天沒動的工作 |
| `o`、`q` | 打開網頁版；離開 |

做完的工作會自己離開看板。看板寫 `progress.md` 跟面板一樣小心；別的對話的區塊不會動，除非你封存一個已經停掉的。

<img alt="左邊是 Codex；右邊是看板，剛按 x 勾掉一步，按鍵說明下面寫著已完成" src="docs/images/live/work-zh-TW.png" width="100%">

<table>
<tr><th width="50%">Codex CLI</th><th width="50%">Antigravity CLI</th></tr>
<tr>
<td><img alt="Codex progress in the interactive board" src="docs/images/live/codex-board-en.jpg" width="100%"></td>
<td><img alt="Antigravity progress in the interactive board" src="docs/images/live/antigravity-board-en.jpg" width="100%"></td>
</tr>
</table>

使用合成資料的互動看板範例；原生 CLI hooks 與實機 ACK 的證據見[獨立驗收紀錄](docs/validation/2026-10-19-native-hooks.md)。

### 看板的網頁

上面的看板指令和技能通常會執行 `--serve`：印出看板、啟動背景伺服器、寫入位址檔、在瀏覽器開啟網頁，並把帶 token 的連結印進 agent 的對話。在任何終端機執行 `node ~/.agent-board/agent-board.mjs --serve` 也一樣（加 `--no-open` 只印網址）。再跑一次 `--serve` 會叫回已經開著的那一頁。在聊天 app 中，技能會改用 `--chat`，不會印出連結。在網頁上可以：

- **勾掉**自己工作的下一步、**封存**一件工作，或按**現在封存**把做完的全部收走。
- **複製**回覆、續接命令或步驟中的指令。
- **已回覆，先隱藏**：已經在它自己的對話裡回過的問題。只在這台電腦上隱藏，網頁、面板和終端機看板都一樣，不會送出任何話。那個對話問新的問題時會再出現；按**重新顯示**可以提早叫回來。
- **傳送**到確切在線的對話。離線 session 保留複製；舊版啟動程序功能須明確加上 `--allow-resume`。[介面支援](docs/MESSAGING.md)。
- **貼入區塊**：保留來源時間，重貼不變更，拒絕過時或衝突的內容；舊資料時間不明時先比較兩份內容。[修復方式](docs/REMOTE_REPORTERS.md)。

網頁只在 127.0.0.1 上聽（除非加上 `--lan`，見下文），網址裡帶一把隨機鑰匙。這台電腦上的任何程式只要有連結就能使用。關掉分頁後本機服務會繼續執行，使用 $agent-board 或 --serve 可重開；按**關閉看板**才停止。可用 --idle-minutes 30 選擇閒置關閉，0 代表停用；LAN 仍保留 10 分鐘限制。傳訊進行中不會關閉。

**在手機上。** 網頁的版面適合手機。要從和電腦連同一個 Wi-Fi 的手機打開，跑 `node ~/.agent-board/agent-board.mjs --serve --lan`：除了電腦本機的網址，它還會印出網頁在你網路上的網址和它的 QR code，用手機相機對著掃就好。電腦有不只一個網路位址時，用 `--lan 192.168.1.23` 指定一個。Windows 可能會問要不要讓 Node.js 使用網路：在私人網路上允許，並確認 Windows 把你的 Wi-Fi 算成私人網路（剛連上的網路它會先當成公用網路），不然手機連不到網頁。跨網路存取須另行設定遠端連線。

網路上的網頁有這些限制：

- 只有加了 `--lan` 才開，只開在電腦的私人位址上（開頭是 192.168、10，或 172.16 到 172.31 的位址，絕不是公開位址），也只回應送到那個位址的請求。
- 它的網址帶著自己的一把鑰匙，不是電腦本機網頁那把。拿到這個網址或拍到 QR code 的人，在它關掉之前都能用這個網頁，所以只在信得過的網路上用，例如家裡的 Wi-Fi，不要在咖啡店的。
- 在網路上，網頁走的是沒有加密的 HTTP，同一個 Wi-Fi 上的其他裝置可能讀得到傳過去的內容，包括 agent 的回答。所以手機可以勾步驟、封存、標成已回覆（和重新顯示）、複製、貼上區塊和關閉看板，但不能回覆 agent：回覆會在電腦上跑一個程式，所以手機只顯示答案讓你複製，再從電腦本機的網頁送出。
- 10 分鐘沒有手機來看就會關，電腦本機的網頁關掉時也跟著關。開著的時候再跑一次 `--serve --lan`，拿到的是同一個網址。

## 指令

以下是選用 Claude Code 側欄的指令；其他 agent 使用上方的看板入口。

| 輸入 | 用途 |
|---|---|
| `/progress` | 打開面板 |
| `/progress connect` | 現在就接上其他 agent，並看看改了什麼；每個對話開始時也會自動做（`/progress connect remove` 拿掉 hook 並停止自動接） |
| `+ 專案：標題 截止 11-20；步驟；步驟` | 在面板輸入框加一件自己的事（或用 `/progress add …`） |
| `/progress open` | 在瀏覽器看 |
| `/progress report` / `/progress today` | 複製最近 7 天／今天的進度 |
| `/progress notify on` / `off` | 桌面通知 |
| `/progress lang zh-TW` | `en`、`zh-TW`、`zh-CN` 或 `auto` |
| `/progress tidy` | 現在就封存做完的工作，以及停太久的工作（見[使用說明](docs/GUIDE.zh-TW.md#它怎麼保持整齊)） |

## 顏色與符號

面板跟著 Claude Code 的主題走。輸入 `/config`，選 **Theme**：選淺色主題，面板就用淺色那組顏色；其他主題用深色那組。`progress.html` 跟著你電腦的淺色或深色模式。兩組都是日本傳統色（和色），選來讓每個字都清楚好讀。

| 符號 | 意思 | | 符號 | 意思 |
|:-:|---|---|:-:|---|
| ● | 等你 | | ◐ | 在跑，或在等別人 |
| ▸ | 正在做 | | ! | 卡住 |
| ○ | 還沒做 | | ⚑ | 兩週內到期 |
| ✓ | 完成 | | – | 取消 |

按面板最下面的「說明」，面板裡也會列出這張表。

## 常見問題

<details>
<summary><b>可以只從一個 agent 開始嗎？</b></summary>

可以，使用共用安裝器從支援的任一 agent 開始，不需要另一家 AI。原生 hooks 依 host 而異；看板和明確回報自身進度的入口共用。
</details>

<details>
<summary><b>我是從 Codex（或其他 agent）裝的，它看得到 Claude Code 在做什麼嗎？</b></summary>

可以，只要各 session 回報到同一個本機進度檔。獨立 reporter 不需要 Claude Code 就能更新自己的區塊；選用側欄也讀同一檔案。開啟看板和接上原生收訊是兩件事。
</details>

<details>
<summary><b>換了一台電腦，東西都不見了嗎？</b></summary>

不會不見，但也不會自己搬過去：`progress.md`、收件匣和 hook 都只在各自的電腦上。在新電腦執行通用安裝器，再重開 agent 就好。要帶上以前的紀錄，就把你選用的 `progress.md` 和旁邊的 `progress-archive-*.md`、`progress-journal-*.md` 複製過去。

想讓兩台電腦共用一個面板，就在兩台都把 `CLAUDE_PROGRESS_FILE` 設成同步資料夾（OneDrive、Dropbox、iCloud）裡的同一個檔案。一次只用一台最穩：兩台同時寫，同步軟體可能會留下衝突副本。
</details>

<details>
<summary><b>某個 agent 沒出現。</b></summary>

1. 執行 `node scripts/setup-agent.mjs` 預覽目前 host，查看衝突與 `adapter-pending`。
2. 依 host 要求重載，完成限定範圍的原生 hook 信任／啟用，再讀回確認。
3. 由該 session 使用自己的原生 id 回報，檢查精確區塊與更新時間；不要替其他 session 猜任務。
4. 另外觀察新的原生生命週期事件。進度出現不代表可以反向收訊，見[接線檢查](docs/MESSAGING.md#connecting-a-session-that-was-already-open)。

選用 Claude 外掛另有 inbox 流程，該安裝可用 `/progress connect status` 查詢；獨立狀態 hooks 不需要 Claude 對話開著。

公開回報問題時，請提供：

- 看板、Node.js（`node --version`）與受影響 agent 的版本；使用選用 Claude 整合時才附該外掛版本。
- 作業系統、哪個 agent、做了什麼、預期結果和實際結果。
- 已移除私人資訊的安裝／doctor 輸出。

不要上傳原始收件匣、進度或對話紀錄檔。分享輸出或截圖前，移除提問、回覆、私人路徑、token（包括看板連結和 QR code），以及人名或專案名稱。請另寫一個小範例。`--chat` 只會盡力隱藏自身輸出中的家目錄路徑和常見憑證格式，無法保證完整，也不會清理診斷檔案。

虛構範例（填上版本，不需要真實對話）：

```text
作業系統：示範系統；看板／Node.js／agent 版本：<版本>
操作：在 demo-1 完成一個回合。預期：看板出現一列。實際：沒有出現。
安裝／doctor：<已檢查並移除私人資訊的狀態>
```

私人或涉及安全性的問題，請透過 GitHub 的 [Report a vulnerability](https://github.com/WenyuChiou/agent-board/security/advisories/new) 回報。詳見 [SECURITY.md](SECURITY.md)（英文）。
</details>

<details>
<summary><b>會把資料傳出去嗎？要花多少錢？</b></summary>

獨立 reporter 只在本機保留挑選過的 session 中繼資料，不呼叫摘要模型。發訊給在線 agent會使用目標 agent 的模型與額度。下列模型與對話存取適用於選用的 Claude 外掛流程：看板檔案儲存在本機。透過你自己的 Claude Code 登入／模型存取，回合摘要會把提問和回覆傳給 Claude Haiku；標題會傳送該對話的第一個請求和步驟名稱；交接行會傳送最多 6,000 個字元的壓縮摘要。面板的側邊提問框也會透過同一個登入，把你的問題傳給模型，依這段對話的紀錄回答。這些呼叫使用該帳號的額度或計費。面板會執行 `git branch --show-current`，裝了 GitHub 的 `gh` 的話，也會用它查 pull request 和 CI 狀態。預設只傳給確切在線的對話；舊版 Codex／Grok 程序續接須明確加上 `--allow-resume`，使用該 agent 的權限與網路。獨立 OpenClaw 外掛停用對話存取；選用 Claude 連接器則設定 `allowConversationAccess: true`。

`--serve` 預設只監聽本機（`127.0.0.1`）；這台電腦上的任何程式只要有連結就能使用。`--serve --lan` 會透過帶 token 的 HTTP 連結，在私人網路分享網頁。token 是存取金鑰，不會加密：同一網路上任何拿到 LAN 連結的人都能讀看板、修改看板檔案（包括匯入區塊），也能停止伺服器。LAN 網頁會拒絕啟動 agent 的回覆，也不顯示恢復對話的指令。私人網路位址不代表咖啡廳或旅館的網路值得信任。不要分享連結或 QR code。要停止服務，請按網頁上的「關閉」按鈕；若正在傳送回覆，請等完成後重試。只關分頁，背景服務會繼續運作；閒置關閉須自行啟用。看板伺服器或 LAN 監聽器每次重新啟動都會產生新的 token，因此停止後舊連結就無法使用。檔案變更、啟動的程式、網路存取和 `--chat` 隱藏資訊的限制，詳見 [SECURITY.md](SECURITY.md)（英文）。
</details>

<details>
<summary><b>Windows 能用嗎？</b></summary>

本機看板支援 macOS、Linux、Windows；原生 hooks 與傳訊依 host 和介面分開驗收，見支援表。獨立 Windows hooks 使用 Node，不需要 `sh`。
</details>

<details>
<summary><b>以前用的是 <code>claude-progress-pane</code>。</b></summary>

外掛在 0.10.0 改了名，不會自己換過去。照[從舊名稱換過來](docs/GUIDE.zh-TW.md#從舊名稱換過來)的步驟做就好，`progress.md` 不會動。
</details>

<details>
<summary><b>怎麼移除？</b></summary>

獨立安裝：先關閉看板，預覽 `node ~/.agent-board/agent-board.mjs --codex-remove --agent <name>`，確認後加上 `--apply`。進度與歷史會保留。選用 Claude 外掛的移除方式：

```sh
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

第一行會把其他 agent 裡的 hook 拿掉；先處理完列出的清理問題，再移除外掛。歷史紀錄、回報腳本和收件匣會留著。重試方式、已經移除外掛時的補救步驟，以及保留檔案的位置，請看使用說明的[完整移除步驟](docs/GUIDE.zh-TW.md#更新與移除)。
</details>

更多問題請看使用說明的[疑難排解](docs/GUIDE.zh-TW.md#疑難排解)。

## 文件

- [使用說明](docs/GUIDE.zh-TW.md)：設定腳本、看懂面板、所有指令、其他 agent、自動整理、疑難排解
- [檔案格式](docs/FORMAT.md)（英文）：`progress.md` 怎麼寫，給任何想寫進去的程式
- [AGENTS.md](AGENTS.md)（英文）：程式碼結構，以及任何 agent 都能照著手動回報的那一段
- [更新紀錄](CHANGELOG.md) · [參與貢獻](CONTRIBUTING.md) · [安全性](SECURITY.md)

## 授權

[MIT](LICENSE)。agent 的圖示來自 [Simple Icons](https://simpleicons.org)（CC0）和 [Lobe Icons](https://github.com/lobehub/lobe-icons)（MIT），商標屬於各自的擁有者；沒有圖示的 agent 以名字的第一個字母表示。

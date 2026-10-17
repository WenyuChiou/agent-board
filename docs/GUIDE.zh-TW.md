# 使用說明

[English](GUIDE.md) · 繁體中文 · [简体中文](GUIDE.zh-CN.md) · [回到 README](../README.zh-TW.md)

## 開始使用

需要 Claude Code 2.1.287 以上。在 2.1.301 和 2.1.302 上測試過。

### 1. 安裝外掛

在 Claude Code 終端機對話的輸入框：

```
/plugin install agent-board --marketplace WenyuChiou/agent-board
```

回答 `y` 加入 marketplace，並選 user scope。或者從 shell 執行：

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

### 2. 執行設定腳本

可以不做。它會做兩項外掛自己做不到的設定，可以重複執行。沒跑也能用：沒有 Task 清單的對話會一回合一回合自動整理。

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\plugins\marketplaces\agent-board\scripts\setup.ps1"
```

macOS / Linux：

```bash
bash ~/.claude/plugins/marketplaces/agent-board/scripts/setup.sh
```

它做的事：

- **打開 Task 工具。** 新模型要設了 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 才有 Claude Code 的 Task 工具，而面板就是跟著這些工具走。腳本把這個變數加進你的 shell 的 profile（PowerShell 是 `$PROFILE`；`~/.zshrc`、`~/.bashrc`、macOS 上是 `~/.bash_profile`，或 `~/.profile`）。不加進 `settings.json`：那裡的 env 也會進到 Claude 桌面 app，而桌面 app 自己有一份待辦清單。
- **打開自動更新**，這個 marketplace 的新版本會自己送到。你自己關掉的自動更新會維持關閉。
- **把舊的安裝換過來**，如果你用過 zip 版。
- **幫你接上其他 agent（要你開口）。** 加上 `--agents`（PowerShell 是 `-Agents auto`），它也會把回報進度的說明交給 Codex、Gemini CLI 和 OpenCode（見[其他 agent](#其他-agent)）。

它改的每個檔案都會先複製一份 `<檔名>.bak`。加上 `-NoInstall`（`--no-install`）可以略過安裝這一步。

### 3. 重新啟動 Claude

開一個**新的**終端機視窗（讓 profile 被讀進去），執行 `claude`。面板會自己在右邊打開。`/progress` 可以重新打開。

### 4. 照常工作

跟 Claude 說任何兩步以上的事：

```
> 設定頁加上深色模式，然後開 PR
```

Claude 會列出 Task 清單，面板跟著走：卡片顯示任務、它的背景、進度條、正在做的步驟和下一步。Claude 需要你決定時，問題會移到**現在最需要你**，附上對應的按鈕。要你看過的東西會有**沒問題**和**要修改**；**要修改**只會打開一個框讓你寫要改什麼，你送出前什麼都不會送。已經在它自己的對話裡回過的問題（這個對話或別的對話），可以按**已回覆，先隱藏**收起來：不會送出任何話，也不改任何對話的區塊，只在這台電腦上隱藏（面板、終端機看板、看板的網頁和 `progress.html` 都從 `progress.md` 旁邊的 `progress-answered.json` 讀這份清單）。那個對話把問題改寫成新的，它就會再出現。**已回覆、隱藏的 N 項**會列出它們，每項都有**重新顯示**。

### 5. 加入不是程式的事

在面板最下面的框裡，打一行以 `+` 開頭的字：

```
+ 求職：Fabrikam 研究獎助 截止 11-20；改履歷；投遞
```

冒號前面是專案，`截止 MM-DD` 設定日期（到期前 14 天排進**快到期**），每個 `；` 開始一個步驟。也可以自己寫進 `~/.claude/progress.md`（見[進度檔](#進度檔)）。

### 6. 打開視窗

```
/progress open
```

會在預設瀏覽器打開 `progress.html`。可以放在第二個螢幕上，它每 30 秒自己重新整理一次。

### 7. 選語言

面板先看 Claude Code 的 `language` 設定，再看系統語系。要自己選：

```
/progress lang zh-TW        # 或 en、zh-CN、auto
```

或在 `/config` 裡設定這個外掛的 **Pane language**。

### 8. 選顏色

面板的顏色跟著 Claude Code 的主題：輸入 `/config`，選 **Theme**。淺色主題（`light`、`light-daltonized`、`light-ansi`）用淺色那組，其他主題用深色那組，一換就立刻重畫。`progress.html` 則跟著你電腦的淺色或深色模式。各個符號的意思，按面板最下面的「說明」就看得到。

## 看懂面板

從上到下：

1. **數字。** `● 等你` · `▸ 進行中` · `⚑ 快到期` · `✓ 今天完成`。點每一個會展開它算的那些項目。
2. **現在最需要你。** 一個最需要你處理的問題、截止日或卡住的任務，寫明它是關於什麼、你可以怎麼做。`還有 N 件等你 ▸` 會展開其餘的。
3. **這個對話的卡片。** 專案和分支、任務、它的背景、進度條、目前的狀況、正在做的步驟和下一步。`▸ 全部 N 步` 列出每一步，有編號，目前這步標著 `← 現在`。有 pull request 的話也顯示在這裡。
4. **收合的區塊。** 等你處理、快到期、其他進行中（依專案分組）、最近完成。點一列可以看它的步驟和可用的操作：**接手做完**（這個專案裡已關閉的對話留下來的工作）、**複製續接指令**（在原來執行的地方重開那個對話）、**完成這步**和**交給 Claude**（你自己手動記的任務），兩種都有**封存**，馬上移出檔案。別的對話問的問題會寫出那個對話的任務和 ID 開頭，也說怎麼回到那個對話：**複製對話 ID** 複製完整的 ID，拿去那個 agent 的對話列表找到它；Claude Code、Codex、Grok Build、Gemini CLI、Hermes Agent 和 OpenCode 還會寫出那個對話關掉之後接回它的指令。沒留下 ID 的對話（例如手寫的區塊或網頁聊天）會直說這裡帶不了你回去。
5. **輸入框。** 問一句旁邊的問題（在面板裡回答，不打斷 Claude），或以 `+` 開頭新增任務。
6. **最下面一排。** 週報 · 通知：開／關 · 說明。

符號：

| 符號 | 意思 |
|---|---|
| `✓` | 完成 |
| `▸` | 正在做 |
| `○` | 還沒做 |
| `●` | 等你 |
| `◐` | 在跑：CI、長時間執行的工作、別人 |
| `!` | 卡住 |
| `–` | 取消 |

## 指令

| 指令 | 作用 |
|---|---|
| `/progress` | 打開面板 |
| `/progress open` | 在瀏覽器打開 `progress.html` |
| `/progress connect` / `connect remove` | 把這台電腦上的其他 agent 接上面板／拿掉 |
| `/progress add <line>` | 新增一件事，和在面板裡打 `+` 一樣 |
| `/progress tidy` | 立刻封存做完的工作，以及停太久的工作（見[它怎麼保持整齊](#它怎麼保持整齊)） |
| `/progress sync` | 重新讀 Claude 的 Task 清單和 PR |
| `/progress report` / `today` | 複製最近 7 天／今天的報告 |
| `/progress notify on` / `off` | 打開或關閉通知 |
| `/progress lang en` / `zh-TW` / `zh-CN` / `auto` | 選面板的語言 |

中文詞也能用：`/progress 視窗`（或 `網頁`）＝ `open`、`加`（或 `新增`）＝ `add`、`整理` ＝ `tidy`、`同步` ＝ `sync`、`週報` ＝ `report`、`今天` ＝ `today`、`通知 開`／`通知 關` ＝ `notify on`／`off`、`語言 zh-TW` ＝ `lang zh-TW`。

## 進度檔

所有內容都放在 `~/.claude/progress.md`（Windows 上是 `%USERPROFILE%\.claude\progress.md`；設定 `CLAUDE_PROGRESS_FILE` 可以改用別的路徑）。它是可以直接讀、直接改的純 Markdown：

```markdown
# 專案進度

## acme-web

<!-- auto session=2be48af2 agent=claude state=waiting updated=2026-10-16T01:40:00Z pr=128 ci=pending -->
### 設定頁加上深色模式
> 等你回覆 · feat/dark-mode · PR #128 · CI 跑中
> 背景：上次問卷很多人要
- [x] 加深色的顏色 token
- [~] 修圖表對比
- [?] 上線方式 — 先用旗標給部分人，還是直接全部開？
- [ ] 開 PR
<!-- /auto session=2be48af2 -->

## 求職

### Contoso 研究駐點
> 截止 10-31
- [x] 改履歷
- [?] 推薦信 — 等李教授回覆
- [ ] 投遞
```

- 每個對話只改寫自己的 `<!-- auto -->` 標記之間的行。其他一切（你手寫的區段、筆記）一個位元組都不動。
- 符號：`[x]` 完成、`[~]` 正在做、`[ ]` 還沒做、`[?]` 等你、`[>]` 在跑、`[!]` 卡住、`[-]` 取消。` — ` 後面的文字是這一步的備註：它需要什麼，或為什麼卡住。
- `截止 MM-DD`（或 `due MM-DD`）寫在任務上就有了日期：到期前 14 天排進快到期，3 天內變紅。

給要讀寫這個檔案的工具用的完整規格在 [docs/FORMAT.md](FORMAT.md)（英文）。

## 其他 agent

Claude Code 會自己接上它們：每個對話開始時，會把這台電腦裝了、但還沒接上的 agent 接上（之後才裝的也一樣），並告訴你一次接了哪些。`/progress connect remove` 會拿掉 hook 並停止自動接；在 `/config` 裡關掉外掛的 **Connect other agents automatically** 也能關掉。想手動接、並看看哪些設定檔改不了，就在 Claude Code 裡執行，或在任何終端機執行 `claude -p "/progress connect"`：

```
/progress connect
```

它會找出這台電腦上裝了哪些 agent，幫每個裝一個在回合結束時執行的 hook。hook 只做一件事：把 agent 交出來的內容（最後的回覆，有給的話也包括你的提問）存進 `~/.claude/progress-inbox/`。開著的 Claude Code 對話幾秒內就會讀到，整理成那個 agent 自己的一塊進度。agent 不用照什麼說明做，也不用記得回報。接上之後，重開那個 agent 才會生效。

| Agent | 改的檔案 | 回合結束事件 |
|---|---|---|
| Codex | `~/.codex/hooks.json`（`$CODEX_HOME`） | `Stop`，第一次要在 Codex 的 `/hooks` 裡核准 |
| Gemini CLI | `~/.gemini/settings.json` | `AfterAgent` |
| Cursor | `~/.cursor/hooks.json` | `afterAgentResponse`、`stop` |
| OpenCode | `~/.config/opencode/plugin/agent-board.js` | `session.idle` |
| Grok Build | `~/.grok/hooks/agent-board.json`（`$GROK_HOME`） | `Stop`。要 Grok 自己在 `~/.grok` 寫了 `config.toml` 或 `sessions` 才算裝了；其他工具放在那個資料夾的 hook 不算 |
| Hermes Agent | `~/.hermes/config.yaml`（`$HERMES_HOME`） | `post_llm_call`，Hermes 第一次跑新 hook 前會問一次，回答 `y` |
| Muse Code | `~/.config/muse/settings.json` | `Stop` |
| OpenClaw | `~/.openclaw/agent-board.mjs`，以及旁邊載入它的 `openclaw.json`（`$OPENCLAW_STATE_DIR`） | `agent_end`，接上後重開它的 gateway |

hook 執行的是 `/progress connect` 寫好的 `~/.claude/progress-report.sh`（Windows 是 `progress-report.ps1`）。腳本：
- 不需要裝任何東西；
- 永遠回 0；
- 什麼都不印，只有 Cursor 會印 `{}`。

其他規則：
- 檔案裡你自己的 hook 會留著。
- 不是純 JSON 的設定檔不會動，指令會告訴你是哪一個；JSON 的第一次會用兩格縮排重寫。
- 之前用 setup `--agents` 寫進那個 agent 說明裡的 AGENTS.md 段落會被拿掉，免得同一件事出現兩次。
- `/progress connect remove` 拿掉回報用的 hook 和我們寫的看板指令，保留的規則見下面。

指令、skill 和獨立腳本只有在整份內容和已知範本、這個外掛上次記下的輸出，或之前某個版本寫的檔案完全一樣時，才會更新或刪掉。原本就是空的檔案和你改過的檔案會留著，警告裡會列出路徑，自動接上時也一樣。想讓 Agent Board 用那個路徑，先把那個檔案改名，再重新接上。沒有紀錄的舊檔案，只有名稱或開頭對得上不算數。

移除時會同時看指令的結果和檔案是不是真的不見了。沒清乾淨就會列出沒能確認或保留下來的路徑；照提示處理後，再跑一次 `/progress connect remove`。只要還有指令或 skill 留著，它們共用的 `agent-board.mjs` 也會留著。回報腳本和收件匣會保留，給排隊中或正在跑的 hook 用；進度檔、封存、日誌，和你自己加進 skill 資料夾的檔案都不會動。紀錄只存外掛產生的內容，放在外掛自己的儲存區，確認刪掉後就清掉。兩個程式同時在連接，或連接時你正好在改檔案，這種情況沒有防護。

要有 Claude Code 對話開著才會更新。都沒開的時候，回合會先存在收件匣，超過兩天的檔案由回報腳本自己清掉。

**其他 agent**（Aider、GitHub Copilot、Windsurf…）：把 [AGENTS.md](../AGENTS.md) 最後那段 **「Report your progress to the progress pane」** 貼進它的說明檔，它就會自己寫一塊。`setup.sh --agents`（`setup.ps1 -Agents auto`）會幫還沒接上的 Codex、Gemini CLI、OpenCode 做這件事。

**在別台機器上的 agent**（雲端 VM、聊天助理）也能回報：它把自己那塊寫成片段，由這台電腦上的合併步驟放進 `progress.md`，見 [Remote reporters](REMOTE_REPORTERS.md)。

**dot，以及 Codex 的明確回報**：自行選用的[本機交換](LOCAL-EXCHANGE.md)寫的也是同一種片段，用同一個合併步驟放進去，並在本機保留一個有回條的訊息佇列。

## 每個 agent 裡都看得到看板

`/progress connect`（以及每個對話開始時）也會在 `progress.md` 旁邊寫一個 `agent-board.mjs`：直接從 `progress.md` 印出看板的腳本，不用開 Claude Code。每個 agent 的看板指令都是用 Node.js 18 以上跑它：Codex 和 Gemini CLI 本來就附 Node；OpenCode、Cursor、Grok Build、Hermes Agent、OpenClaw、Antigravity 若 `node --version` 找不到，請裝一下。

| Agent | 檔案 | 打 |
|---|---|---|
| Gemini CLI | `~/.gemini/commands/board.toml` | `/board`。Gemini 第一次會問要不要讓指令執行 |
| OpenCode | `~/.config/opencode/commands/board.md` | `/board` |
| Codex、Cursor、Grok Build、OpenClaw、Muse Code（還有 Gemini CLI、OpenCode） | `~/.agents/skills/agent-board/SKILL.md` | Codex 打 `$agent-board`，其他打 `/agent-board` |
| Hermes Agent | `~/.hermes/skills/agent-board/SKILL.md` | `/agent-board` |
| Antigravity | `~/.gemini/config/skills/agent-board/SKILL.md` | `/agent-board` |

Gemini CLI 和 OpenCode 會自己把看板貼進提示；用技能（skill）的，則是 agent 執行腳本再把印出的東西給你看。Codex、Gemini CLI、OpenCode 實際跑過（接測試用的假模型，見下圖）；Cursor、Grok Build、OpenClaw、Hermes Agent、Antigravity 的技能照它們文件寫的位置放，沒有實際跑過。Antigravity 只能看看板：它還沒有回合結束的 hook 可以回報。

在終端機：`node ~/.claude/agent-board.mjs` 印一次看板，`--watch` 一直開著、每 2 秒重畫（分割視窗放在 Codex 旁邊），`--html` 寫出 `progress.html` 並在瀏覽器打開。`--lang zh-TW`（或 `en`、`zh-CN`）選語言；預設用你替面板選的語言：先看 `/config` 裡這個外掛的 **Pane language**，再看你最後以 `/progress lang` 選的語言（選 `auto` 時是那個對話的語言）；都沒選過就用第一個寫出它的 Claude Code 對話的語言。

在終端機裡，`--watch` 也能用按鍵操作，就像面板能點：↑↓ 和 Enter 選一行並展開、`x` 勾掉手寫工作的下一步、`a` 封存手寫的工作或已停對話的區塊（做完的會自己封存）、`1`–`9` 或 `y`／`n` 複製另一個 agent 問題的答案、`c` 複製指令，或接回提問那個對話的指令（沒有指令就複製它的 ID）、`h` 把另一個 agent 的問題標成已回覆（只在這台電腦上隱藏，不送出任何話）、`u` 把隱藏的全部重新顯示、`o` 打開網頁版、`q` 離開。除了這幾個和已回覆的清單，看板只讀不寫。其他 agent 的 hook 留在收件匣的回合，要有開著的 Claude Code 對話才會整理成步驟；在那之前，看板照原樣列出它們，問題排最前面。只是看看板的回合，不算工作。

`--serve` 先印出看板，再在瀏覽器打開它的網頁，同樣的事在那裡按一下就好：勾步驟、封存一件工作或全部做完的、複製答案或指令、把問題標成已回覆、回覆已經結束的 Grok Build 或 Codex 對話（在那個對話自己的資料夾裡，一次一則），以及貼上網頁聊天寫的區塊。上面每個看板指令都會跑它，所以 agent 給你看的最後一行就是網址。網頁只在 127.0.0.1 上提供，網址裡帶一把隨機鑰匙，30 分鐘沒人看就會關；詳見[看板的網頁](../README.zh-TW.md#看板的網頁)。agent 回的話等它回來才會出現在網頁上，可能要幾分鐘；還有一則在路上時，網頁不會關。agent 若在沙箱裡跑指令，可能不准開網頁：看板照樣印出，最後一行會說網頁打不開。這時自己在終端機跑 `node ~/.claude/agent-board.mjs --serve`。

要從同一個 Wi-Fi 上的手機看網頁，加上 `--lan`：`node ~/.claude/agent-board.mjs --serve --lan` 還會印出網頁在你網路上的網址，和一個手機相機掃了就能開的 QR code。那個網頁有自己的鑰匙，10 分鐘沒有手機來看就會關。手機在那裡能勾步驟、封存、標成已回覆（和重新顯示）、複製、貼上區塊，但回覆 agent 要從電腦上送。只在信得過的網路上用，原因見[看板的網頁](../README.zh-TW.md#看板的網頁)。

如果終端機看板讀不到或存不了某個檔案，它會在 stderr 印出完整路徑和檔案系統的錯誤；用 `--keys` 時會以狀態 1 結束。只有檔案不存在（`ENOENT`）才當成空的。先修好檔案權限或騰出磁碟空間，看一下 `progress.md` 和那個月的封存與日誌，再重試。`--watch` 每次重畫都會再讀一次，權限恢復後就會自己好。

終端機會先把完成的那一步寫進日誌，才勾掉那一步；先把工作寫進封存，才把它從檔案裡拿掉。所以之後寫看板如果失敗，可能會同時留下歷史紀錄和原本的工作，這時它會說沒有全部存好，而不是說成功。重試封存時，已經存過一模一樣的那一筆會跳過。這不是跨檔案的交易，也不是跨程式的鎖，擋不住別的程式蓋掉一次成功的更新。換檔案時會保留原本 POSIX 的讀、寫、執行權限，新的歷史檔只有你自己能讀；檔案的擁有者、延伸 ACL 和當機後資料一定還在，這次都不保證。

<img alt="終端機裡的看板，每 2 秒重畫" src="images/live/terminal-zh-TW.png" width="560">
<img alt="OpenCode 1.19.3：/board" src="images/live/opencode-zh-TW.png" width="560">

## 它怎麼保持整齊

| 項目 | 時機 |
|---|---|
| 做完的區塊移到 `progress-archive-YYYY-MM.md` | 最後一次更新後 12 小時 |
| 其他區塊也移到那裡 | 最後一次更新後 3 天 |
| 手寫、每一步都打勾的任務移到那裡 | 面板第一次看到它做完後 24 小時 |
| 12 小時沒有寫入的對話 | 顯示為對話已停；它的問題不再出現在現在最需要你 |
| 你在已停的對話或手記的任務按**封存** | 馬上 |
| 封存後變空的 `##` 區段 | 會被移除；你自己留空的會保留 |

這個清理在對話開始時執行，之後每小時一次。`/progress tidy` 和面板的封存按鈕會立刻執行，而且做完的工作不用等：剛做完的區塊、每步都勾完的手寫工作會馬上移走（別的對話做完的區塊也是；那個對話之後再寫，它的區塊會回來）。停掉的對話還是等三天。

## 更新與移除

自動更新打開時（設定腳本會幫你打開），新版本會自己送到。要手動更新：

```
claude plugin marketplace update agent-board
claude plugin update agent-board@agent-board
```

然後在執行中的對話裡打 `/reload-plugins`，或開新的對話。

要移除：

```
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

`progress.md`、它的封存檔和日誌，以及 shell 的 profile 裡那一行都會留著。

### 從舊名稱換過來

0.10 以前外掛叫 `project-progress`，來自 `claude-progress-pane` marketplace。設定腳本會自動幫你換；要手動換：

```
claude plugin uninstall project-progress@claude-progress-pane
claude plugin marketplace remove claude-progress-pane
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
```

最後一行會把裝在其他 agent 裡的 hook 換成新名字。`progress.md` 原封不動。面板的語言和通知設定會回到預設，用 `/progress lang` 和 `/progress 通知` 再設一次。

## 疑難排解

- **面板說這個對話沒有 Task 工具。** 執行設定腳本，然後從新的終端機視窗啟動 `claude`。一直拿不到這個變數的對話（桌面 app、Windows 上的 git-bash）還是可以手動維護 `progress.md`。
- **畫面上沒有面板。** 在終端機的全螢幕版面裡，面板從 144 欄寬起會自己停靠在右邊，用 `/progress` 的話從 110 欄起。在 tmux 或 `CLAUDE_CODE_NO_FLICKER=0` 下，它會在輸入框上方。雲端對話不畫面板。
- **PowerShell 警告執行原則。** PowerShell 要允許執行腳本才會執行你的 profile：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，然後再跑一次腳本。在那之前，這個變數會留在 `settings.json`。
- **私人 fork。** Claude Code 用你自己的 git 認證 clone。執行一次 `gh auth login` 和 `gh auth setup-git`；沒有 GitHub SSH key 的話，再設 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`。
- **你的組織統一管理 Claude Code。** 在那種環境裡，你自己裝的外掛收不到系統提示的 hook。執行設定腳本時加 `-KeepRule`（`--keep-rule`），改把規則留在 `~/.claude/CLAUDE.md`。
- **某個 agent 沒出現。** 再跑一次 `/progress connect`：它會列出接上了哪些 agent，以及哪些設定檔改不了。重開那個 agent，並在它工作時開著一個 Claude Code 對話。開著的對話讀完 `~/.claude/progress-inbox/` 裡的檔案就會刪掉，所以要看 hook 存了什麼，先關掉所有對話：回合結束後那裡沒有新檔案，就是那個 agent 的 hook 沒有執行。看板沒能收下的回合（`progress.md` 寫不進去，或模型沒給摘要、回覆裡也沒有提問）會以 `.taking` 檔留在那裡，每 15 分鐘再試一次；試滿 8 次就改成 `.failed` 檔保留，不會刪掉。
- **Windows 上的 Cursor 停在「blocked」。** `cursor-agent` 一律用 bash 跑 hook，連寫給 PowerShell 的也是，所以 `~/.cursor/hooks.json` 裡其他工具的 PowerShell hook 會出現 `syntax error near unexpected token '&'`；`preToolUse` hook 失敗會擋住整個回合（Agent Board 的 hook 根本輪不到）。修好或拿掉那個工具的 hook。
- **Hermes Agent 單次執行的問題顯示成已停，不是等你。** `hermes -q` 回合一結束就關掉對話，所以問你事情的那塊會顯示「對話已結束，可接手」。問題仍是最後一步；長時間開著的 Hermes（它的 gateway）就會維持等你。
- **換了一台電腦。** `progress.md`、收件匣和 hook 都只在各自的電腦上。在新電腦安裝並執行 `/progress connect`；要帶上紀錄，就把 `progress.md` 和旁邊的 `progress-archive-*.md`、`progress-journal-*.md` 複製過去。要兩台共用一個面板，就在兩台都把 `CLAUDE_PROGRESS_FILE` 指向同步資料夾裡的同一個檔案，並且一次只用一台。

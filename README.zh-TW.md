<h1 align="center">
<img alt="簡短導覽：五個 agent，其中一個在等你；直接在面板回答；每個 agent 透過自己的 hook 回報；什麼都不會漏；在哪裡用；淺色深色兩種配色。" src="docs/images/tour-zh-TW.svg" width="100%">
</h1>

<p align="center">
<b>每個 AI coding agent 在做什麼，一個面板看完；等你的事，永遠排第一個。</b><br>
Claude Code 外掛，也跟得上 Codex、Gemini CLI、OpenCode、Grok Build、Hermes Agent 和 OpenClaw（都實測過），更多見下表。
</p>

<p align="center">
<a href="CHANGELOG.md"><img alt="版本 0.18.0" src="https://img.shields.io/badge/version-0.18.0-blue"></a>
<img alt="需要 Claude Code 2.1.287 以上" src="https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.287-d97757">
<a href="LICENSE"><img alt="MIT 授權" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS、Linux、Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>
<p align="center">
<a href="#支援的-agent"><img alt="實測過 Codex 0.163.0" src="https://img.shields.io/badge/Codex-0.163.0-brightgreen"></a>
<a href="#支援的-agent"><img alt="實測過 Gemini CLI 0.64.0" src="https://img.shields.io/badge/Gemini%20CLI-0.64.0-brightgreen"></a>
<a href="#支援的-agent"><img alt="實測過 OpenCode 1.19.3" src="https://img.shields.io/badge/OpenCode-1.19.3-brightgreen"></a>
<a href="#支援的-agent"><img alt="實測過 Grok Build 1.0.62" src="https://img.shields.io/badge/Grok%20Build-1.0.62-yellowgreen"></a>
<a href="#支援的-agent"><img alt="實測過 Hermes Agent 0.19.0" src="https://img.shields.io/badge/Hermes%20Agent-0.19.0-yellowgreen"></a>
<a href="#支援的-agent"><img alt="實測過 OpenClaw 2026.10.4" src="https://img.shields.io/badge/OpenClaw-2026.10.4-yellowgreen"></a>
</p>

<p align="center"><a href="README.md">English</a> · 繁體中文 · <a href="README.zh-CN.md">简体中文</a></p>

你在一個專案開 Claude Code，另一個開 Codex，第三個開 Gemini。二十分鐘後，其中一個停下來問你事情，你要等到剛好切回去才會發現。**Agent Board** 在它一開口就把問題放到你眼前，每個答案一個按鈕。

## 支援的 agent

### 一眼看懂

**完全可用**：回合會自己上看板，在它裡面也叫得出看板，兩者都實測過。
- **Claude Code** 2.1.302（面板）
- **Codex** 0.163.0（`$agent-board`）
- **Gemini CLI** 0.64.0（`/board`）
- **OpenCode** 1.19.3（`/board`）

**部分可用**：缺什麼寫在後面。
- **Grok Build** 1.0.62：回合實測過；在它裡面叫看板（`/agent-board`）還沒實測
- **Hermes Agent** 0.19.0：兩者都能用；`hermes -q` 單次提問會顯示成已停，不是等你
- **OpenClaw** 2026.10.4：兩者都能用；需要 2026.4.24 以上，會警告無法確認 plugin 來源
- **dot**、網頁版 **Muse**、**其他 agent**：沒有 hook，要貼一段提示、再合併它寫的區塊；在它裡面看不到看板

**還不能用**：**Cursor**（Windows 上 hook 被擋；macOS、Linux 沒測）、**Muse Code** CLI（沒實測）、**Antigravity**（沒有回合結束的 hook）。

下表依能力逐項列出細節。

✅ 可以用，實測過 · ⚠️ 可以用，但有最後一欄寫的限制 · ❔ 照 agent 文件寫的，還沒實測 · ❌ 不能用。頂端的 agent 徽章：綠色是完全可用，黃綠色是部分可用。

| | Agent | 回合會出現在看板 | 在它裡面看看板 | 實測版本 | 要知道的事 |
|:-:|---|:-:|:-:|---|---|
| <img src="docs/images/agents/claude-code.svg" width="24" alt=""> | **Claude Code** | ✅ | ✅ 面板 | 2.1.302 | 每個對話自己出現；問題點一下就回答 |
| <img src="docs/images/agents/codex.svg" width="24" alt=""> | **Codex** | ✅ | ✅ `$agent-board` | 0.163.0 | 第一次要在 Codex 的 `/hooks` 核准 |
| <img src="docs/images/agents/gemini-cli.svg" width="24" alt=""> | **Gemini CLI** | ✅ | ✅ `/board` | 0.64.0 | 第一次 `/board` 會問一次要不要讓指令執行 |
| <img src="docs/images/agents/opencode.svg" width="24" alt=""> | **OpenCode** | ✅ | ✅ `/board` | 1.19.3 |  |
| <img src="docs/images/agents/grok-build.svg" width="24" alt=""> | **Grok Build** | ✅ | ❔ `/agent-board` | 1.0.62 |  |
| <img src="docs/images/agents/hermes-agent.svg" width="24" alt=""> | **Hermes Agent** | ⚠️ | ✅ `/agent-board` | 0.19.0、0.16.0（Windows） | 回答一次 `y`。單次執行的 `hermes -q` 問的問題會顯示成已停，不是等你 |
| <img src="docs/images/agents/openclaw.svg" width="24" alt=""> | **OpenClaw** | ⚠️ | ✅ `/agent-board` | 2026.10.4 | 要 2026.4.24 以上；太舊的不會接，並會告訴你。它會警告「無法確認這個外掛的來源」，但照樣載入 |
| <img src="docs/images/agents/cursor.svg" width="24" alt=""> | **Cursor** | ❌ | ❔ `/agent-board` | cursor-agent 2026.10.16（Windows） | 還沒看到它成功：Windows 上 Cursor 用 bash 跑所有 hook，其他工具的 PowerShell hook 擋住了回合。macOS、Linux 沒測 |
| <img src="docs/images/agents/muse-code.svg" width="24" alt=""> | **Muse Code** | ❔ | ❔ |  | hook 照它的文件寫；Muse 只測過網頁版（下一列） |
|  | **Antigravity** | ❌ | ❔ `/agent-board` |  | 還沒有回合結束的 hook，只能看看板 |
|  | **dot**、網頁版 **Muse** | ⚠️ | ❌ | 網頁版，2026 年 10 月 | 沒有 hook：把[一段提示](docs/REMOTE_REPORTERS.md#chat-relay-a-prompt-to-paste)貼進聊天，再把它寫的每一塊合併進來 |
|  | **其他 agent**（Aider、Copilot、Windsurf…） | ⚠️ | ❌ |  | 把 [AGENTS.md](AGENTS.md) 的一段貼進它的說明檔，它會自己寫一塊 |

在其他 agent 裡看看板，看得到全部，但那是印出來的文字，不能點。要勾步驟、封存或複製回答，在旁邊的終端機開[可以操作的看板](#每個-agent-裡都看得到看板)。回答問題則在問的那個 agent 裡（面板會給你要貼過去的那句話或指令）。「實測版本」是真的跑過一個回合、hook 有觸發、面板畫出正確區塊的版本，那些真實資料都留在測試裡。下面是看板讀它們的樣子：

<img alt="看板列出 6 家 agent 實測時各自問的問題：Codex、Gemini CLI、OpenClaw、OpenCode、Grok Build、Hermes Agent" src="docs/images/live/hooks-zh-TW.png" width="620">

## 快速開始

**1. 安裝**（需要 Claude Code 2.1.287 以上）：

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
```

**2. 打開 Claude Code。** 面板在右邊（沒看到就輸入 `/progress`）。第一次開的時候，它會自動接上這台電腦裝的所有 coding agent，並告訴你接了哪些；之後才裝的 agent，下次開 Claude Code 時也會自動接上。

**3. 重開其他 agent 一次**，讓它們載入新的 hook。第一次時，Codex 要在 `/hooks` 裡核准，Hermes Agent 會問你一次，回答 `y`。之後每個 agent 的回合幾秒內就會出現。

<details>
<summary><b>或者讓 agent 幫你裝</b></summary>

把下面這段貼給 Codex、Gemini CLI、Cursor、Grok、Hermes、Muse，或任何能執行指令的 agent：

```text
幫我在這台電腦裝 Claude Code 的 Agent Board 外掛，並把這台電腦上的 coding agent 接上它。
依序執行這三行，任何一行失敗就停下來告訴我：
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
最後把最後一行印出的內容給我看，並告訴我要重開哪些 agent。
```

</details>

## 功能

- **需要你的事排最前面。** 任何 agent 的問題都放在最上面，每個答案一個按鈕。在 Claude Code 裡按一下就回答了；其他 agent 則給你要貼過去的那句話或指令。
- **所有 agent 一處看。** 依專案分組，每個對話都有標題、一行背景和編號步驟，由每個回合的簡短摘要自動寫好。
- **隨時接著做。** 對話壓縮、終端機關掉、隔天早上都沒關係：做完什麼、卡在哪、下一步是什麼，打開就看到。做到一半停掉的對話，按一下就能接手。
- **你自己的待辦也放得進來。** 在面板的輸入框打 `+ 求職：Fabrikam 研究員 截止 11-20`。快到期會變黃，到期會變紅。
- **不在終端機也看得到。** `/progress open` 在瀏覽器打開同一個畫面（手機也行）。面板關著時，狀態列和桌面通知會告訴你有事在等你。
- **週報。** `/progress report` 和 `/progress today` 把做完的事複製成文字。
- **自己收拾。** 做完的事移到每月封存檔，日誌留下每一步完成紀錄。
- **就是一個 Markdown 檔。** 全部在 `~/.claude/progress.md`，你可以自己看、自己改。支援 English、繁體中文、简体中文；淺色深色都有。

## 每個 agent 裡都看得到看板

接上時，每個 agent 也會拿到一個看看板的指令。不管你在哪一個裡面，都看得到全部 agent 在做什麼：

| 在 | 打 |
|---|---|
| Gemini CLI、OpenCode | `/board` |
| Codex | `$agent-board` |
| Cursor、Grok Build、OpenClaw、Hermes Agent、Antigravity | `/agent-board` |
| 任何終端機，開在任何 agent 旁邊 | `node ~/.claude/agent-board.mjs --watch`（`--html` 在瀏覽器開） |

**像面板一樣操作。** 在 agent 旁邊開一個終端機（分割視窗），`node ~/.claude/agent-board.mjs --watch` 就是能操作的看板：↑↓ 選一行、Enter 展開、`x` 勾掉自己工作的下一步、`a` 封存做完或停掉的、`1`–`9`（或 `y`／`n`）把另一個 agent 問題的答案複製起來好貼過去、`c` 複製指令、`o` 打開網頁版、`q` 離開。勾掉的步驟會記進工作日誌。它寫 `progress.md` 的方式跟面板一樣小心：先寫暫存檔、再讀回確認，別的對話剛好也在寫就重做一次；別的對話的區塊不會動，除了封存已經停掉的。

<img alt="左邊是 Codex；右邊是看板，剛按 x 勾掉一步，按鍵說明下面寫著已完成" src="docs/images/live/work-zh-TW.png" width="100%">


<table><tr>
<td><img alt="Codex CLI 0.163.0：打 $agent-board，跑看板腳本並顯示看板" src="docs/images/live/codex-zh-TW.png"></td>
<td><img alt="Gemini CLI 0.64.0：/board 把看板貼進提示" src="docs/images/live/gemini-zh-TW.png"></td>
</tr></table>

截圖是 Codex 0.163.0 和 Gemini CLI 0.64.0 實際執行的畫面（模型用的是測試用的假模型）；OpenCode 和終端機的截圖在[使用說明](docs/GUIDE.zh-TW.md#每個-agent-裡都看得到看板)。看板直接讀 `progress.md`，不用開 Claude Code；它用 Node.js 18 以上執行，Codex 和 Gemini CLI 裝的時候就有（其他 agent 若 `node --version` 找不到，就裝一下 Node）。其他 agent 的回合要有 Claude Code 對話開著才會整理成步驟；在那之前，看板照原樣列出它們。

## 指令

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

## 怎麼運作

<img alt="Claude Code 對話、透過 hook 的其他 agent、和你，都寫進同一個 Markdown 檔 progress.md；面板、progress.html、封存與狀態列都讀它。" src="docs/images/flow-zh-TW.svg" width="100%">

每個接上的 agent，hook 會把它最後的回覆存進 `~/.claude/progress-inbox/`。開著的 Claude Code 對話五秒內讀到，把那個回合整理好，寫進 `progress.md` 裡那個 agent 自己的一塊，然後刪掉那個檔案。格式寫在 [docs/FORMAT.md](docs/FORMAT.md)（英文）。

## 常見問題

<details>
<summary><b>一定要有其他 agent 嗎？只用 Claude Code 可以嗎？</b></summary>

可以。每個 Claude Code 對話都會自己出現；接上其他 agent 是選用的。
</details>

<details>
<summary><b>我是從 Codex（或其他 agent）裝的，它看得到 Claude Code 在做什麼嗎？</b></summary>

看得到。插件裝在 Claude Code 裡，但接上時每個 agent 都會拿到看看板的指令（見[每個 agent 裡都看得到看板](#每個-agent-裡都看得到看板)），而看板讀的就是所有 agent 共用的那個檔案。想讓其他 agent 的回合整理成步驟，就在某處開著一個 Claude Code 對話。
</details>

<details>
<summary><b>換了一台電腦，東西都不見了嗎？</b></summary>

不會不見，但也不會自己搬過去：`progress.md`、收件匣和 hook 都只在各自的電腦上。在新電腦跑那三行安裝指令，再重開 agent 就好。要帶上以前的紀錄，就把 `~/.claude/progress.md` 和旁邊的 `progress-archive-*.md`、`progress-journal-*.md` 複製過去。

想讓兩台電腦共用一個面板，就在兩台都把 `CLAUDE_PROGRESS_FILE` 設成同步資料夾（OneDrive、Dropbox、iCloud）裡的同一個檔案。一次只用一台最穩：兩台同時寫，同步軟體可能會留下衝突副本。
</details>

<details>
<summary><b>某個 agent 沒出現。</b></summary>

1. 再跑一次 `/progress connect`，看它印出什麼：它會列出接上了哪些 agent，以及哪些設定檔改不了。
2. 重開那個 agent，hook 是在啟動時載入的。Codex 要在 `/hooks` 核准，Hermes Agent 會問一次。
3. 開著一個 Claude Code 對話：面板只在有對話開著時讀收件匣。這段期間進來的回合會在那裡等，最多兩天。
4. 先關掉所有 Claude Code 對話（開著的對話幾秒內就會讀走並刪掉檔案），再看看 `~/.claude/progress-inbox/`。回合結束後沒有新檔案，就是 hook 沒跑；有檔案卻沒出現，請開 issue 附上那個檔案。
</details>

<details>
<summary><b>會把資料傳出去嗎？要花多少錢？</b></summary>

`progress.md`、收件匣和 `progress.html` 都留在你的電腦上。回合的摘要由 Claude Haiku 透過你自己的 Claude Code 登入來做：其他 agent 每個回合一次簡短呼叫，沒有 Task 清單的 Claude Code 對話也是。裝了 GitHub 的 `gh` 的話，面板會用它查你的 pull request 狀態。其他什麼都不會送出去。詳見 [SECURITY.md](SECURITY.md)（英文）。
</details>

<details>
<summary><b>Windows 能用嗎？</b></summary>

可以：macOS、Linux、Windows，在終端機、桌面版和 VS Code 都行。Windows 上的 hook 跑的是 PowerShell 腳本，不需要 `sh`。
</details>

<details>
<summary><b>以前用的是 <code>claude-progress-pane</code>。</b></summary>

外掛在 0.10.0 改了名，不會自己換過去。照[從舊名稱換過來](docs/GUIDE.zh-TW.md#從舊名稱換過來)的步驟做就好，`progress.md` 不會動。
</details>

<details>
<summary><b>怎麼移除？</b></summary>

```
claude -p "/progress connect remove"
claude plugin uninstall agent-board@agent-board
claude plugin marketplace remove agent-board
```

第一行會把其他 agent 裡的 hook 拿掉。`progress.md` 會留著。
</details>

更多問題請看使用說明的[疑難排解](docs/GUIDE.zh-TW.md#疑難排解)。

## 文件

- [使用說明](docs/GUIDE.zh-TW.md)：設定腳本、看懂面板、所有指令、其他 agent、自動整理、疑難排解
- [檔案格式](docs/FORMAT.md)（英文）：`progress.md` 怎麼寫，給任何想寫進去的程式
- [AGENTS.md](AGENTS.md)（英文）：程式碼結構，以及任何 agent 都能照著手動回報的那一段
- [更新紀錄](CHANGELOG.md) · [參與貢獻](CONTRIBUTING.md) · [安全性](SECURITY.md)

## 授權

[MIT](LICENSE)。agent 的圖示來自 [Simple Icons](https://simpleicons.org)（CC0），商標屬於各自的擁有者；沒有免費圖示的 agent 以名字的第一個字母表示。

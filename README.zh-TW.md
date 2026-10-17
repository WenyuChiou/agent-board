<h1 align="center">
<img alt="簡短導覽：五個 agent，其中一個在等你；直接在面板回答；每個 agent 透過自己的 hook 回報；什麼都不會漏；在哪裡用；淺色深色兩種配色。" src="docs/images/tour-zh-TW.svg" width="100%">
</h1>

<p align="center">
<b>每個 AI coding agent 在做什麼，一個面板看完；等你的事，永遠排第一個。</b><br>
Claude Code 外掛，也跟得上 Codex、Gemini CLI、Cursor、OpenCode、Grok Build、Hermes Agent 和 Muse Code。
</p>

<p align="center">
<a href="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml"><img alt="測試" src="https://github.com/WenyuChiou/agent-board/actions/workflows/test.yml/badge.svg"></a>
<a href="CHANGELOG.md"><img alt="版本 0.11.0" src="https://img.shields.io/badge/version-0.11.0-blue"></a>
<a href="LICENSE"><img alt="MIT 授權" src="https://img.shields.io/badge/license-MIT-green"></a>
<img alt="macOS、Linux、Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>

<p align="center"><a href="README.md">English</a> · 繁體中文 · <a href="README.zh-CN.md">简体中文</a></p>

你在一個專案開 Claude Code，另一個開 Codex，第三個開 Gemini。二十分鐘後，其中一個停下來問你事情，你要等到剛好切回去才會發現。**Agent Board** 在它一開口就把問題放到你眼前，每個答案一個按鈕。

## 支援的 agent

| | Agent | 怎麼回報 | 你要做一次的事 | 實測過 |
|:-:|---|---|---|---|
| <img src="docs/images/agents/claude-code.svg" width="24" alt=""> | **Claude Code** | 內建：每個對話都會出現，有沒有 Task 清單都行 | 不用做什麼 | ✅ 2.1.302 |
| <img src="docs/images/agents/codex.svg" width="24" alt=""> | **Codex** | `Stop` hook | `/progress connect`，再到 Codex 的 `/hooks` 核准 | ✅ |
| <img src="docs/images/agents/gemini-cli.svg" width="24" alt=""> | **Gemini CLI** | `AfterAgent` hook | `/progress connect` | ✅ 0.64.0 |
| <img src="docs/images/agents/opencode.svg" width="24" alt=""> | **OpenCode** | 外掛，在 `session.idle` 時 | `/progress connect` | ✅ 1.19.3 |
| <img src="docs/images/agents/grok-build.svg" width="24" alt=""> | **Grok Build** | `Stop` hook | `/progress connect` | ✅ 1.0.62 |
| <img src="docs/images/agents/hermes-agent.svg" width="24" alt=""> | **Hermes Agent** | `post_llm_call` shell hook | `/progress connect`，Hermes 第一次問時回答 `y` | ✅ 0.19.0 |
| <img src="docs/images/agents/cursor.svg" width="24" alt=""> | **Cursor** | `afterAgentResponse` hook | `/progress connect` | 依 Cursor 文件實作 |
| <img src="docs/images/agents/muse-code.svg" width="24" alt=""> | **Muse Code** | `Stop` hook | `/progress connect` | 依 Muse 文件實作 |
| | **其他 agent**（Aider、Copilot、Windsurf…） | 自己寫一塊進度 | 把 [AGENTS.md](AGENTS.md) 的一段貼進它的說明檔 | |

「實測過」是指：真的 CLI 跑了一個回合，它的 hook 有觸發，面板也從中畫出正確的一塊進度。那些真實資料都留在測試裡。

## 快速開始

**1. 安裝**（需要 Claude Code 2.1.287 以上）：

```
claude plugin marketplace add WenyuChiou/agent-board
claude plugin install agent-board@agent-board
claude -p "/progress connect"
```

**2. 重開其他 agent**，讓它們載入新的 hook。第一次時，Codex 要在 `/hooks` 裡核准，Hermes Agent 會問你一次，回答 `y`。

**3. 打開 Claude Code。** 面板在右邊（沒看到就輸入 `/progress`）。每個 agent 的回合幾秒內就會出現。

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

## 指令

| 輸入 | 用途 |
|---|---|
| `/progress` | 打開面板 |
| `/progress connect` | 把其他 agent 接上（`/progress connect remove` 拿掉 hook） |
| `+ 專案：標題 截止 11-20；步驟；步驟` | 在面板輸入框加一件自己的事（或用 `/progress add …`） |
| `/progress open` | 在瀏覽器看 |
| `/progress report` / `/progress today` | 複製最近 7 天／今天的進度 |
| `/progress notify on` / `off` | 桌面通知 |
| `/progress lang zh-TW` | `en`、`zh-TW`、`zh-CN` 或 `auto` |
| `/progress tidy` | 現在就封存做完的事 |

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

每個接上的 agent，hook 會把它最後的回覆存進 `~/.claude/progress-inbox/`。開著的 Claude Code 對話五秒內讀到，把那個回合整理好，寫進 `progress.md` 裡那個 agent 自己的一塊。格式寫在 [docs/FORMAT.md](docs/FORMAT.md)（英文）。

## 常見問題

<details>
<summary><b>一定要有其他 agent 嗎？只用 Claude Code 可以嗎？</b></summary>

可以。每個 Claude Code 對話都會自己出現；接上其他 agent 是選用的。
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
4. 看看 `~/.claude/progress-inbox/`。回合結束後沒有新檔案，就是 hook 沒跑；有檔案卻沒出現，請開 issue 附上那個檔案。
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

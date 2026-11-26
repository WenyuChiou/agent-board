# The board page, redesign 1: order and layout first

Written by the PM on 2026-11-24, at the owner's ask: 「另外UI應該要先行優化 你可以先做這部分優化的設計」. A design for the owner's review, **not in force**. The mockup, on synthetic data, is `docs/dev/ui-mockup-0.26.0.html`: its 提案 switch (bottom right) shows the 沒事, 過時 and 深色 states, and it was checked at 1280, 1440 (detail rail) and 375 px.

The work order is the owner's: order and layout first, then the card, then the wording. The page code is `hooks/serve.ts` (CSS around `:1059-1350`, the page script after `:2000`). It needs no hook change, so this lane can start at once and run beside the delivery work.

## Design context (from the owner, not inferred from the code)

- **Who:** one person running three to six AI agents across desktop apps and CLIs (Claude Code, Codex, Antigravity, DeepSeek). The board sits in a docked window or a browser tab, and sometimes on a phone.
- **The job:** see at a glance whether anything needs them, answer it in place, and see what is running. Product principle 7: "Show only what needs you."
- **The feel:** quiet, exact, quick. It should read like a good mail client or T3 Code's sidebar, not like a dashboard.
- **Anti-references:** a page that explains itself in sentences, red alarms about file sizes, and the AI look in general (「UIUX可以用一些github去AI味道」).
- **What the owner gave (#209 7148340095):**
  - less text, and no AI names in sentences;
  - smaller type, folded by default;
  - no 你的待辦 group;
  - a summary column that is not a quarter of the page;
  - no storage notices;
  - search and filters on a par with T3 Code;
  - the footer flush with the bottom edge.
- **Kept:** the current palette (the Japanese traditional colours: 藍 `#165E83` accent, gold for "needs you", green for done) and both themes. The gold badge stays the one loud colour on the page.

## Layout, desktop (1024 px and wider)

```
┌────────────┬──────────────────────────────────────────────┬─────────────┐
│ Agent•Board│ 需要你                                        │ (detail     │
│ ⌕ 搜尋  /  │ [AI ▾] [專案 ▾] [介面 ▾]   清除                │  rail, only │
│            │                                              │  when an    │
│ 需要你   4 │ 需要你 4                                      │  item is    │
│ 進行中   2 │ Ds 用較大的 worker 重跑昨晚的批次嗎？          │  selected,  │
│ 全部       │    data-pipeline · 29 分       [好] [不要] 回覆│  ≥1440 px)  │
│            │ Ag Pick a layout — A or C?                    │             │
│ AI         │    demo-site · 16 分              [A] [C] 回覆│             │
│ Cl Claude 1│ Cx 選擇模型：ECMWF 或本地模型？                │             │
│ Cx Codex  1│    weather-model · 7 分  [ECMWF][本地模型] 回覆│             │
│ Ag Antigr 1│ ○  重接看板，再確認卡片有出現                  │             │
│ Ds DeepSk 1│    Cl reservoir-paper · 3 分                  │             │
│            │ ›  等別人 2                                    │             │
│ 專案 ▸     │                                              │             │
│            │ 進行中 2 · 已停止 1 · 已完成 1 · 看全部 ›      │             │
├────────────┤                                              │             │
│v0.26 ⚙ ⏻  │                                              │             │
└────────────┴──────────────────────────────────────────────┴─────────────┘
```

1. **Sidebar, 208 px.**
   - At the top: the wordmark and a search field (`/` focuses it).
   - Three views, here only (the phone shows them as tabs):
     - **需要你** (count, the default): only what needs the person, then one quiet line, 「進行中 2 · 已停止 1 · 已完成 1 · 看全部 ›」.
     - **進行中** (count): running work only.
     - **全部**: every section, with 需要你 first.
   - **AI**: a mark, the name, and a small `CLI` or `App` (both when the person uses both). On the right, a gold count badge when something waits on the person; otherwise a filled dot ("working") or a ring ("open, no news"). No status words. Marks are monochrome, so the gold badge stays the one loud colour; real AI icons replace the two-letter marks of the mockup.
   - **專案**: folded by default.
   - **The footer** (version, settings, close) sits flush with the bottom edge. No padding under it.
2. **One work column**, at most 760 px wide, left-aligned in the space beside the sidebar. No second summary column (today `minmax(460px,5fr) minmax(0,6fr)`, `serve.ts:1340`).
3. **The filter bar** over the work: chips for AI, 專案 and 介面 (CLI or App). No state chip, since the views do that. Each chip is a multi-select menu with counts, and 清除 shows only while a filter or search is on. Filters and search apply to every section; clicking an AI or project in the sidebar sets the same filter.
4. **需要你, in this order:**
   1. questions from an AI, the longest wait first (a wait of 15 minutes or more shows its age in gold);
   2. the person's own do-now steps (hand-kept). Each has a round check on the left (pressing it marks the step done) and, on line 2, the small mark of the AI session that wrote it (the owner: 「待辦去掉放各家AI」). No 你的待辦 group;
   3. steps that wait on someone else, folded into one line, 「等別人 · 2」; open, each is a row, 「等 Alex · 推 … · 41 分」.
5. **An item, folded to two lines.**
   - Line 1: the AI's mark, then the question, 14 px/600, cut to one line.
   - Line 2: the project and the age on the left; on the right up to two answer chips and 回覆, 13 px.
   - Pressing the item opens it in place: the full question, the task, the context, the steps, a command, 自己寫, and 封存 / 隱藏.
   - At most three controls show on a folded item.
   - **Reply status, on line 2,** in the words of the plan's status line (plan-0.26.0.md, B4): 傳送中 → 已送達 → 已回覆. Then the item leaves 需要你 and shows at the top of 進行中, flashing once. A reply past its budget reads 不確定 · 看它的視窗, never sent again by itself; one refused reads 未送達, with one next step. This carries the "correct and timely" status the owner asked for.
6. **進行中**: one row each, the latest first, with the mark, the title, the progress (a 36 px bar and `1/3`), the project and the age, in fixed columns so they line up.
7. **已停止 and 已完成**: one folded line each, with a count. 全部封存 sits in 已停止's header, with undo.
8. **Detail rail**, 1440 px and wider: selecting an item opens a 320 px rail with its detail, and Esc closes it. Nothing shows there when nothing is selected.
9. **Undo**: every 完成, 封存 or 隱藏 shows a toast with 復原 for 8 s (#566).

## Phone (below 640 px)

- At the top: search, then the AI chips with their names and badges (scrolling sideways), then the three views as tabs.
- Items keep the same two lines, without the answer chips. Pressing one opens a bottom sheet: the question, the context, the steps, the answers as 44 px buttons, 自己寫, and 封存 / 隱藏.
- The round check on the left replaces the full-width black 已完成 button.
- 進行中 rows drop the bar and the project, keeping `1/3` and the age.

## Type and space

- **Sizes:** 12 px (meta), 13 px (secondary), 14 px (body and item titles; weight 600 sets the titles apart), 18 px (the view title only). No 20 px inside items.
- **Line height:** 1.45 for body text, 1.3 for one-line titles.
- **Spacing:** the existing 4-px scale (`--s1`–`--s7`). Items sit 4 px apart inside a section and 32 px apart between sections.
- **Cards:** none. Items are rows on one surface, split by hairlines, so there are no cards inside cards.

## What goes

- **The storage notices** (「看板越來越大了。」, 「progress.md 已有 551 KB…」). Tidying runs on its own, and the page speaks only when a write fails.
- **The 你的待辦 group** (items under their project instead).
- **The explanation sentences on cards** (「看板還不能傳訊息到這個 Codex 對話：…」). Until delivery lands, a small 需貼上 tag carries the detail in its tooltip.
- **The 批次封存 form**, replaced by 全部封存 with undo.
- **The command box under a title** that repeats the command: the command shows once, on open.

## States

- **需要你 empty:** 「沒有要你回的事」, plus the time of the last update.
- **The page is stale** (no update for 2 minutes): one quiet line at the top, 「2 分鐘沒更新 · 重新整理」.
- **Search finds nothing:** 「找不到「…」」 and 清除.
- **An AI not connected:** its row in the sidebar is grey, with a tooltip.

## Issues

The plan (plan-0.26.0.md, section D) holds them:
- **Must-ship:** N7 no storage notices (P1); N8 no 你的待辦 group (P2); #269 the order (P3); N9 the footer (P4); N11 search and filters (P5); N12 one work column and the rail (P6); N13 two-line items and smaller type (P7).
- **Ships if ready:** #566 undo (P8); the narrow-width layout (P9); #1023; #1014 (notify).
- **With the delivery lines, not the page lane:** the reply status on the item (B4's words, line L10).
- Each issue gets a Done-when and a page test, as section D lists.

---

## Redesign 2: the item and the words

> **Status: design proposal only — not in force until the owner approves. Zero code or string-table changes in this PR.**

Redesign 1 settled the page skeleton (208 px sidebar, one `<=760 px` work column, `<=340 px` detail rail at `>=1440 px`, search/filters, and flush sidebar footer). Redesign 2 specifies **the item, its controls, the states, keyboard triage, phone sheet, and the 16-string cut list** across all three languages (`zh-TW`, `en`, `zh-CN`), directly addressing #209 comment 7148340095 ("in the UI, order and layout first, then the card, then wording") and #1023's first line.

### 1. The 16-string cut list (zh-TW, en, zh-CN)

Rule from #209 (7148340095): **no sentence that explains the mechanism, no AI name in a sentence, no file names or byte counts.**

| # | String key | Current text (zh-TW / en / zh-CN) | Redesign 2 (zh-TW / en / zh-CN) | Where it goes |
|---|---|---|---|---|
| 1 | `boardLarge` | `看板越來越大了。` / `The board is getting large.` / `看板越来越大了。` | **Removed from first screen** (replaced by quiet cleanup action in Settings only when cleanable) | Removed from `#board` top |
| 2 | `progressLarge` | `progress.md 已有 {kb} KB，超過 {cap} KB；手寫的工作與等你回覆的步驟都不會被刪` / `progress.md is {kb} KB, over {cap} KB; hand-kept tasks and steps waiting on you are never removed` / `progress.md 已有 {kb} KB，超过 {cap} KB；手写的工作与等你回复的步骤都不会被删` | **Cut file name (`progress.md`), byte count (`KB`), and reassuring clause** -> `可清理舊紀錄` / `Old records can be cleaned up` / `可清理旧记录` | Settings → Storage only |
| 3 | `storeLarge` | `看板存的紀錄已有 {mb} MB（上限 {cap} MB）；只有區塊已離開看板的 session 紀錄會被清掉，其餘都會保留` / `The board's saved records are {mb} MB (limit {cap} MB); only records of sessions whose block has left the board are cleared, and the rest stay` / `看板存的记录已有 {mb} MB（上限 {cap} MB）；只有区块已离开看板的 session 记录会被清掉，其余都会保留` | **Cut byte count (`MB`) and session-block mechanism** -> folded into the single Settings storage line above | Settings → Storage only |
| 4 | `tidyBulk` | `批次封存` / `Bulk archive` / `批量归档` | **Replaced by one-click header action** -> `全部封存` / `Archive all` / `全部归档` (with 8 s `復原` / `Undo` / `撤销` toast; drops the 7-control `tidy-bulk` form) | `已停止` section header |
| 5 | `pgNothing` | `目前「需要你」清單沒有項目。` / `Nothing in the current Needs you list.` / `当前“需要你”列表没有项目。` | `沒有要你回的事` / `Nothing needs you` / `没有要你回的事` | Empty `需要你` state (+ `#1023` clock) |
| 6 | `pgNothingHint` | `代理程式問你問題或卡住時，會顯示在這裡，分頁標題也會顯示數字。` / `When an agent asks you something or gets stuck, it shows up here, and the tab title shows a number.` / `代理问你问题或卡住时，会显示在这里，标签页标题也会显示数字。` | **Removed** (no sentence explaining how the board works) | Removed |
| 7 | `pgNoWorking` | `過去 30 分鐘沒有代理程式有動作。` / `No agent has done anything in the last 30 minutes.` / `过去 30 分钟没有代理有动作。` | `沒有進行中的工作` / `Nothing running` / `没有进行中的工作` | `進行中` view empty state (omitted in `需要你`) |
| 8 | `pgQuietAsking` | `現在沒有代理程式在工作。它們問你的事在「需要你」裡（{n}）。` / `No agent is at work right now. What they asked is under Needs you ({n}).` / `现在没有代理在工作。它们问你的事在“需要你”里（{n}）。` | **Removed** (redundant when `需要你` is already shown) | Removed |
| 9 | `pgQuietStopped` | `現在沒有代理程式在工作。{agent} {minutes} 分鐘前還在做。` / `No agent is at work right now. {agent} last worked {minutes} min ago.` / `现在没有代理在工作。{agent} {minutes} 分钟前还在做。` | **Removed** (AI name in sentence; stopped work sits in `已停止`) | Removed |
| 10 | `pgNoQuestions` | `{name} 在目前「需要你」清單沒有項目。` / `{name} has no items in the current Needs you list.` / `{name} 在当前“需要你”列表没有项目。` | **Unified filter/search empty line** -> `找不到「…」` / `Nothing matching "…"` / `找不到“…”` (or `沒有符合的項目` / `Nothing matches` / `没有符合的项目`) + `清除` / `Clear` / `清除` | Filtered empty state |
| 11 | `pgNoQuestionsElsewhere` | `{name} 沒有要你處理的；其他地方還有 {count} 項在等你。` / `{name} has nothing for you; {count} more wait elsewhere.` / `{name} 没有要你处理的；其他地方还有 {count} 项在等你。` | **Removed** (AI name in sentence; sidebar gold badges already show counts elsewhere) | Removed |
| 12 | `serveCodexCopyHint` | `看板還不能傳訊息到這個 Codex 對話：請複製訊息、貼到 Codex，你在那裡送出後 Codex 就會讀到。` / `The board can't send to this Codex conversation yet: copy the message, paste it into Codex, and Codex reads it when you send it there.` / `看板还不能发消息到这个 Codex 对话：请复制消息、粘贴到 Codex，你在那里发送后 Codex 就会读到。` | **Tag:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `看板還不能直接傳送到這個對話；按複製後貼到視窗送出` / `Direct send is unavailable for this chat; copy and paste into its window` / `看板还不能直接发送到这个对话；点复制后贴到窗口发送` | Item tag + tooltip (disappears once delivery lands) |
| 13 | `serveCodexResumePrompt` | `在電腦上續接這個 Codex 對話，再於 Codex 送出一次提示以重新連線。連上後再從那台電腦的看板傳送；只重新開啟對話還不會連線。` / `Resume this Codex conversation on the computer, then submit one prompt in Codex to reconnect. Once connected, send from the board on that computer; reopening alone does not reconnect it.` / `在电脑上恢复这个 Codex 对话，再在 Codex 中发送一次提示以重新连接。连接后再从那台电脑的看板发送；仅重新打开对话还不会连接。` | **Tag:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `需在電腦重新連線後才能直接送出；可先複製續接指令` / `Reconnect in the terminal on the computer to send directly; resume command inside` / `需在电脑重新连接后才能直接发送；可先复制续接命令` | Item tag + tooltip; resume command stays inside opened detail |
| 14 | `serveLineNone` | `{agent} 還不能從看板收訊息：請複製後貼到它的對話裡。` / `{agent} can't receive messages from the board yet: copy this and paste it into its chat.` / `{agent} 还不能从看板收消息：请复制后贴到它的会话里。` | **Tag:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `貼到它的對話視窗送出` / `Paste into its chat window to send` / `贴到它的对话窗口发送` | Item tag + tooltip |
| 15 | `serveSendOpen` | `{agent} 沒有連上這個看板。請複製後貼到那邊。` / `{agent} isn't connected to this board. Copy this and paste it there.` / `{agent} 没有连上这个看板。请复制后粘贴到那边。` | **Tag:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `尚未連上這個看板；回覆需貼到對話視窗` / `Not connected to this board; paste replies into its window` / `尚未连上这个看板；回复需贴到对话窗口` | Item tag + tooltip & grey sidebar row tooltip |
| 16 | `serveSendNone` | `{agent} 收不到這裡傳的話：複製後貼到它的對話。` / `{agent} can't take a message from here: copy it and paste it into its chat.` / `{agent} 收不到这里发的话：复制后贴到它的对话。` | **Tag:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `這個對話無法從看板收訊息；請複製貼上` / `This chat cannot receive from the board; copy and paste` / `这个对话无法从看板收消息；请复制粘贴` | Item tag + tooltip |

Related follow-up tightenings (same rule, outside the 16 primary cuts):
- `serveLineUnrecorded`, `serveLineStateUnknown`, `serveLineShadowed`, `serveManualReply`, and `serveLanSend` also collapse from multi-sentence card copy into the `需貼上` (`Paste to send` / `需粘贴`) tag with their exact reason in the tag tooltip.
- `answeredHide` (`已回覆，先隱藏` / `Already answered, hide` / `已回复，先隐藏`) shortens to `隱藏` / `Hide` / `隐藏` inside the opened item's secondary actions.
- **Preserved untouched (plan B4):** `傳送中` -> `已送達` -> `已回覆`, `不確定 · 看它的視窗`, and `未送達` keep their exact words and semantics.

### 2. The `需貼上` tag and tooltip

- When a waiting item or session cannot accept a direct reply from the board, the item no longer renders a 2–3 line explanatory paragraph inside the card body.
- Instead, line 2 (`.it-m`, `13 px`) or the opened detail header shows a compact pill tag `需貼上` (`Paste to send` / `需粘贴`) tinted with `--waiting-fill` at low fill and `--waiting-text` (`>= 4.5:1` contrast in light & dark).
- Hovering or keyboard-focusing the tag reveals the full reason in its tooltip (`title` + accessible tooltip/description).
- Once live delivery lands for that surface, the `需貼上` tag disappears without leaving dead copy behind.

### 3. The action row (<= 3 controls, no 1-char wrapping)

- **Folded desktop item (`>= 640 px`):** at most **3 controls** sit right-aligned in `.acts` on line 2 (`13 px`):
  - Connected question with choices: up to **2 answer chips** (`[ECMWF]`, `[本地模型]`) + **`回覆`** (ghost button opening the inline/rail composer).
  - Paste-only question: **`需貼上`** tag + **`複製`** + **`回覆`** (still `<= 3` controls).
  - Hand-kept `mine` task: leading round check button on line 1 (no extra action buttons on the folded row).
- **No label squeezing:** `.acts` uses `flex: none` and buttons use `white-space: nowrap; flex: none` (minimum horizontal padding `10 px`, height `26 px` on desktop). Button labels never collapse to 1 character per line at `1280 px` or `375 px`.
- **Phone (`< 640 px`):** inline `.acts` are hidden from the folded 2-line item so the question and `project · age` never fight for horizontal room; tapping the row opens the bottom sheet with full-width **44 px** buttons.

### 4. Command shown once, on open

- A task's command (`$ claude -p "/progress connect"`, or resume command) is **removed** from the folded card/title area.
- It renders **once**, inside the opened detail view (inline `.d` below `1440 px`, right-hand `.rail` at `>= 1440 px`, or `.sheet` on phone `< 640 px`), in a single horizontal scrollable `.cmd` strip with a copy icon button (`aria-label="複製指令"`).

### 5. `全部封存` in `已停止` header

- The 7-control `批次封存` (`tidy-bulk`) form (`<select>` kind + text input + Preview + Confirm + Cancel) at the bottom of the page is **removed**.
- A single quiet text button **`全部封存`** (`Archive all` / `全部归档`) sits right-aligned inside the `已停止` fold header.
- Pressing `全部封存` archives all currently matching stopped items immediately (optimistic UI) and surfaces the 8-second toast `已封存 N 項 · 復原` (`Archived N · Undo`).

### 6. Sidebar gold badge priority (finding 5)

- Sidebar AI rows never print status words like `正在做` or `等你回覆`.
- Right-hand indicator precedence per AI row:
  1. **Waiting on the person (`n > 0`):** gold count badge (`.badge`, the one loud colour on the page) — **overrides** any concurrent running dot so a waiting question is never hidden behind "working" (fixes finding 5). Its tooltip notes both (`Codex · 1 件需要你，另有 1 項進行中`).
  2. **Running (`n === 0` and active task):** solid status dot (`.st.run`).
  3. **Open, idle (`n === 0`, not running, connected):** hollow ring (`.st.open`).
  4. **Not connected:** greyed-out row (`.ai-row.is-off`, muted monochrome mark, dashed/offline indicator) with tooltip (`尚未連上這個看板 · 需貼上`).

### 7. All board states

| State | Visual & copy contract |
|---|---|
| **Empty (`需要你` = 0)** | `沒有要你回的事` (`14 px` / `600`) + `#1023` timestamp (`上次更新 HH:MM`, `12 px` muted). |
| **Stale (`#1023` / 2 min no update)** | Top warning strip `2 分鐘沒更新 · 重新整理` (undimmed); `.list` and `.others` dim to `opacity: 0.55` until the next good poll. |
| **Nothing found (search or filter)** | Single line `找不到「{query}」` (or `沒有符合的項目` for chip-only filters) + `清除` text button. |
| **AI not connected** | Sidebar row is greyed (`.ai-row.is-off`, `opacity: 0.58`, monochrome mark) with tooltip explaining why; its waiting items carry the `需貼上` tag + tooltip. |

### 8. Phone (`P9`, `< 640 px`)

- **Top bar (`.m-top`, sticky):** compact `A•B` mark, search input (`36 px` height, `/` or tap), Settings icon button (`44×44 px` hit target).
- **AI strip (`.m-ai`):** sideways-scrolling chips (`scrollbar-width: none`) showing `全部`, then each AI with monochrome mark, name, and gold count badge when `n > 0` (greyed when disconnected).
- **View tabs (`.m-tabs`, sticky):** segmented 3-tab bar for `需要你` (with gold badge), `進行中` (with count), and `全部`.
- **Folded items:** same 2-line density as desktop without `.acts` buttons; `進行中` rows drop the progress bar and project column, keeping `1/3` and `age`.
- **Bottom sheet (`.sheet` + `.scrim`):** slides up with `overscroll-behavior: contain`; shows AI mark + surface + project + age, `16 px` title, context, steps, command (once), **44 px** answer choice buttons (`.sheet .big .btn`, `min-height: 44px; height: 44px`), `自己寫` textarea (`16 px` font to avoid mobile zoom) + `送出` (`min-height: 44px`), and `封存` / `隱藏` (`min-height: 44px`).

### 9. `#1023`'s first line

- Right beside or directly under the `18 px` view heading (`.w-head`), a compact first-line summary + freshness pair answers "does anything need me, and is this page current?" in one glance:
  - **Summary:** `{needs} 件等你 · {running} 進行中 · 本週完成 {done}` (from the same counts as the sidebar/tabs, `tabular-nums`, `12 px` muted).
  - **Freshness:** `剛剛更新` / `N 秒前更新` (`12 px` muted).
- **Poll-failure dimming:** when polling fails past budget or the board enters stale state, the freshness line switches to `2 分鐘沒更新 · 重新整理` (`--waiting-text` / `--alert` >= 4.5:1) and `.list` + `.others` dim to `opacity: 0.55` while the header and stale bar stay full contrast.

### 10. Keyboard triage rules

| Key | Context | Action |
|---|---|---|
| `/` | Not typing in `<input>` / `<textarea>` | Focuses search (`#q` on desktop, `#mq` on phone); `e.preventDefault()`. |
| `Esc` | Anywhere | Closes/clears in order: (1) blur input (and clear search if non-empty and focused), (2) close open filter menu, (3) close detail rail (`S.sel`), inline opened item (`S.open`), or phone bottom sheet (`S.sheet`). |
| `j` / `↓` | Not typing | Moves keyboard focus to the next item row (`.it-r` / `.row`) in the visible list. |
| `k` / `↑` | Not typing | Moves keyboard focus to the previous item row. |
| `Enter` | Focused on an item row | Opens/selects that item (inline detail `< 1440 px`, detail rail `>= 1440 px`, bottom sheet `< 640 px`). |
| `Space` | Focused on an item row | For a hand-kept `mine` item, marks it done (with 8 s `復原` toast); otherwise toggles open/select, preventing page scroll. |

### 11. References (patterns only, never product look or brand)

- **T3 Code** (`pingdotgg/t3code`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`, `Sidebar.tsx`, and `packages/client-runtime/src/state/threadSearch.ts`):
  - Two-line compact row anatomy (`min-w-0 flex-1 truncate` title, leading provider/status mark, right-aligned `tabular-nums` relative timestamp).
  - Hover/focus tooltip (`SidebarThreadTooltip`) carrying secondary environment/connection diagnostics instead of multi-line prose inside the row.
  - Visual recession (`opacity` + muted/grayscale treatment via `shouldRecedeSidebarThread`) for settled or disconnected entries.
  - Stable search ranking/display while typing (`visibleThreadSearch` / `nextShownOrder` preventing row flicker) and `Enter`/`Space` row activation.
- **Claude Code (`claude agents`)**:
  - Explicit state model separating `running`, `waiting` (with `waiting_for` reason such as `permission_prompt` / `user_question`), `completed`, and `failed` — motivating Redesign 2's strict rule that a waiting state (`n > 0` gold badge) always overrides a concurrent `running` dot in the sidebar (finding 5).
- **Linear inbox & mail clients**:
  - Single-column triage list (`<= 760 px`) with an optional wide-screen side detail rail (`<= 340 px` at `>= 1440 px`), `j`/`k`/`Enter` keyboard loop, optimistic removal with an 8 s `Undo` toast instead of confirmation dialogs, and header-level `Archive all` replacing multi-field bulk forms.
- **GitHub notifications inbox**:
  - Monochrome provider marks reserving saturated colour strictly for actionable waiting counts, folded secondary shelves (`等別人`, `已停止`, `已完成`), multi-select filter chips with item counts + single `Clear` reset, and query-echoing empty results (`找不到「…」`).
- **The 4 design skills**:
  - `impeccable`: 4-pt spatial scale (`--s1`–`--s7`), 4-step type scale (`12/13/14/18 px`), tinted neutrals with `>= 4.5:1` contrast in light & dark, hairline list rows without nested cards, zero `border-left > 1px` or gradient-text AI tells, and concise UX writing ("make every word earn its place").
  - `web-design-guidelines`: `:focus-visible` outlines, `role="button"` + `tabindex="0"` + `aria-expanded` / `aria-current` / `aria-pressed`, `aria-live="polite"` toast, `tabular-nums`, `min-w-0` truncation guards, `overscroll-behavior: contain` on the bottom sheet, `16 px` mobile inputs, and `prefers-reduced-motion` support.
  - `emil-design-eng`: zero animation on frequent keyboard triage (`j`/`k`/`/`/`Esc`), snappy `140–240 ms` `ease-out` / drawer transitions using `transform` and `opacity` only, subtle `scale(0.97)` `:active` press feedback, and `@media (hover: hover) and (pointer: fine)` hover gating.
  - `critique`: Nielsen's 10 heuristics and cognitive-load cap (`<= 3` folded controls per item, `<= 4` visible options at any decision point).

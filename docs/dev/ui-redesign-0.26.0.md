# The board page, redesign 1: order and layout first

Written by the PM on 2026-11-24, at the owner's ask: 「另外UI應該要先行優化 你可以先做這部分優化的設計」. Approved by the owner with plan #1837 (2026-11-24, US Eastern) and in force. The mockup, on synthetic data, is `docs/dev/ui-mockup-0.26.0.html`: its 提案 switch (bottom right) shows the 沒事, 過時 and 深色 states, and it was checked at 1280, 1440 (detail rail) and 375 px.

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

> **Status: in force as merged (owner, 2026-11-26, 「全照建議」).** Issue N15 builds its item controls; L10 carries 送出, 收回 and 不確定.

Redesign 1 settled the page skeleton (208 px sidebar, one `<= 760 px` work column, `320 px` detail rail at `>= 1440 px` within `#1849`'s `<= 340 px` cap, search/filters, and flush sidebar footer). Redesign 2 specifies **Agent Board's visual identity, the compact interactive pulse and freshness pill bar (`#1023`), the item and its icon/button micro-controls, all board states, keyboard triage, phone sheet, and the 16-string cut list** across all three languages (`zh-TW`, `en`, `zh-CN`), directly addressing `#209` comments `7148340095` ("in the UI, order and layout first, then the card, then wording") and `7154088026`, plus `#1023`'s first line.

### 0. Positioning and Agent Board visual identity

- **Positioning (`#209` `7154088026`):** *"T3 Code is a place to run new agent sessions. Agent Board works with the sessions you already have, in the apps you already use."* Agent Board is a **cross-vendor decision triage desk above open CLIs and desktop apps**, not a per-thread session host. It borrows compact list mechanics without adopting another app's chrome, keeping Agent Board's own identity unmistakable at first glance.
- **Corner Light brand mark (`hooks/page-look.ts`):**
  - The desktop sidebar renders `.ab-logo` (`108×18 px` outlined Inter SemiBold wordmark with the Corner Light between the words, `role="img" aria-label="Agent Board"`), and the phone top bar renders `.ab-icon` (`24×24 px` `64`-grid board with top-right light), paired with the dynamic `<link rel="icon" type="image/svg+xml">` tab icon (`rgb(...)` SVG data URI swapping between calm ink and lit amber).
  - Both marks synchronize four live state classes (`LOGO_STATES`), honoring `prefers-reduced-motion: reduce`:
    1. `is-waiting` (`Needs you > 0`, live): light fills with amber `--brand` (`#C87D00` light / `#F8B500` dark) with a subtle `.ab-halo` glow and lit amber tab icon.
    2. `is-working` (`Needs you = 0` and `Working > 0`): breathing `--ink` dot (`2.4 s`).
    3. `is-idle` (`Needs you = 0` and `Working = 0`, live): steady `--ink` dot.
    4. `is-offline` (stale / poll failed): dimmed wordmark or hollow stroked board with a muted/hollow dot.
- **Ai-tinted Washi & Luminous Yamabuki light palette + Inkstone dark palette:**
  - Replaces the old greenish `#f1f2ee` ground, harsh `#ffffff` surface, and muddy `#8A6700` gold with a crisp pale washi mist palette tinted ~1.5% toward Deep Ai-iro (`#185A7D`) while keeping dark Inkstone (`--ground: #141617` / `--surface: #1e2022` / `--waiting-fill: #F8B500`) cohesive:
    - **Light surfaces & ink:** ground `#F3F5F7` (Ai-tinted pale washi mist), surface `#FCFDFE` (Crisp Hakuji elevated paper for sidebar, `.needs-sheet`, rail, and sheet), inset `#EAEFF2` (recessed stone for search & `.cmd`), borders `#E0E6EB` (`--line`) / `#C8D2DA` (`--line-strong`), ink `#172026`, muted `#525B63` (`>= 6.0:1`), Ai-iro accent `#185A7D` (`--on-fill: #FCFDFE`), brand `#C87D00`, done `#0D7444` (`#3FAE6A` dark), running `#6E4F94`, alert `#B4272D`, project `#005243`, and AI tile `--tile-bg: #EEF2F5` / `1 px solid #D4DDE4` (`#26292C` / `1 px solid #363A3E` in dark).
    - **Luminous Yamabuki waiting gold:** `--waiting-fill: #F4B41A` paired with deep sumi text `--waiting-on: #231800` (`>= 9.4:1` WCAG AAA) and `#D4960A` (`--waiting-edge`) border accent on `.flag` and `.badge` (`#F8B500` / `#141617` / `#E0A300` in dark), replacing muddy `#8A6700`, while reserving `--waiting-text: #8A5200` on `--paste-bg: #FEF5DC` / `--paste-line: #E9C46A` for overdue ages, `需貼上`, and `[⚠ 2m · 重整]` (`>= 5.8:1`).
    - All text/surface token pairs are verified `>= 4.5:1` WCAG AA across light & dark.
- **Swallowtail `.flag` + raised Washoku `.needs-sheet`:**
  - Attaches Agent Board's signature swallowtail `.flag` (`clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 50%, 100% 100%, 0 100%)`, `border-radius: 6px 0 0 0`) to the top-left of the raised `.needs-sheet` (`border: 1px solid var(--line-strong); border-radius: 0 10px 10px 10px`).
  - **Conditional gold:** when `Needs you > 0`, `.flag` is `--waiting-fill` with `--waiting-on` text and `--waiting-edge` bottom accent (`需要你 N`, `tabular-nums`); when `Needs you = 0`, `.flag.calm` recedes to neutral surface/border (`需要你 0`, `clip-path: none; border-radius: 6px 6px 0 0`) so gold appears **only** when something truly needs the person.
  - **Single heading in `需要你` view:** in `需要你` view, `.flag` **is** the `18 px` `<h1>` heading — removing the duplicate `<h1>需要你</h1>` + `<h2 class="sec-h">需要你 N</h2>` double header. Only `進行中` and `全部` render a standalone `18 px` view heading (inside `全部`, `.flag` renders as a `14 px` `<h2>`).
- **Icon-only AI identity (`AGENT_ICONS`) + distinct `>_ CLI` / `❐ App` surface badges + 4-shape presence:**
  - Official inline SVGs from `hooks/agent-icons.ts` render monochrome (`currentColor`) inside `.mk` porcelain/inkstone tiles and carry AI identity cleanly without repeating vendor names (`Claude`, `Codex`, `Antigravity`, `DeepSeek`, …) across the workspace:
    - **Sidebar `#ai-list` rows** show `[22×22 px official monochrome AI SVG tile] + [surface micro-badges] + [gold badge / 4-shape status dot]` with **zero visible AI name text** (full descriptive `aria-label` stays for screen readers, e.g. `Claude · App · 1 件需要你`, while hover `[data-tip]` stays AI-name-free).
    - **Phone `#m-ai` strip (`< 640 px`)** shows `[全部]` + compact icon chips `[20×20 px AI SVG] + [>_ / ❐ icon-only surface pill(s)] + [gold badge]` (keeping `>_ CLI` / `❐ App` icon+text on desktop and phone `.sheet`), allowing all 4–5 AIs to fit comfortably on `375 px` without clipping.
    - **Opened `.rail .r-head`, inline `.d-head`, and phone `.sheet .r-head`** show `[AI SVG tile] + [>_ CLI / ❐ App badge] + [project · age]`, dropping typed vendor names so project names do not truncate on `320 px` rails.
    - **Vendor names remain only inside the `[AI ▾]` filter dropdown checklist** where a person explicitly picks vendors from a menu.
  - **Visually distinct `>_ CLI` vs `❐ App` surface badges (`.surf-pill`, icon + hue, never text-only, `#851`, `#852`):**
    - **`CLI`:** `10 px` terminal-prompt SVG (`>_`) + `CLI` on recessed stone (`--surf-cli-bg: #ECEFF2`, `--surf-cli-line: #CFD7DE`, `--surf-cli-ink: #434B52` light; `#25282B`, `#3D4145`, `#C9C7BE` dark).
    - **`App`:** `10 px` desktop-window SVG (`❐`) + `App` on soft Ai-iro-tinted surface (`--surf-app-bg: #E7F2F8`, `--surf-app-line: #B8D4E3`, `--surf-app-ink: #185A7D` light; `#182930`, `#2B4C59`, `#5EC2CC` dark).
    - When an AI has both `CLI` and `App` sessions active, sidebar `#ai-list` rows (and phone `#m-ai` chips) render both distinct badges cleanly side-by-side.
  - Sidebar AI rows encode presence by **shape + colour** (zero status words): gold count `.badge` (`--waiting-fill` / `--waiting-on`) overriding running when `n > 0`; solid green circle `.st.run` (`8×8 px`) when running; hollow green ring `.st.open` (`8×8 px`) when open and idle; muted horizontal dash `.st.off` (`8×2 px`) when disconnected.

### 1. The 16-string cut list (zh-TW, en, zh-CN)

Rule from `#209` (`7148340095`): **no sentence that explains the mechanism, no AI name in a sentence or tooltip, no file names or byte counts.**

| # | String key | Current text (zh-TW / en / zh-CN) | Redesign 2 (zh-TW / en / zh-CN) | Where it goes |
|---|---|---|---|---|
| 1 | `boardLarge` | `看板越來越大了。` / `The board is getting large.` / `看板越来越大了。` | **Removed** (tidying runs on its own, and the page speaks only when a write fails) | Removed |
| 2 | `progressLarge` | `progress.md 已有 {kb} KB，超過 {cap} KB；手寫的工作與等你回覆的步驟都不會被刪` / `progress.md is {kb} KB, over {cap} KB; hand-kept tasks and steps waiting on you are never removed` / `progress.md 已有 {kb} KB，超过 {cap} KB；手写的工作与等你回复的步骤都不会被删` | **Removed** (tidying runs on its own, and the page speaks only when a write fails) | Removed |
| 3 | `storeLarge` | `看板存的紀錄已有 {mb} MB（上限 {cap} MB）；只有區塊已離開看板的 session 紀錄會被清掉，其餘都會保留` / `The board's saved records are {mb} MB (limit {cap} MB); only records of sessions whose block has left the board are cleared, and the rest stay` / `看板存的记录已有 {mb} MB（上限 {cap} MB）；只有区块已离开看板的 session 记录会被清掉，其余都会保留` | **Removed** (tidying runs on its own, and the page speaks only when a write fails) | Removed |
| 4 | `tidyBulk` | `批次封存` / `Bulk archive` / `批量归档` | **Replaced by compact header icon+label pill** -> `[📦 全部封存]` / `[📦 Archive all]` / `[📦 全部归档]` (with 8 s `復原` / `Undo` / `撤销` toast; drops the 7-control `tidy-bulk` form) | `已停止` fold header |
| 5 | `pgNothing` | `目前「需要你」清單沒有項目。` / `Nothing in the current Needs you list.` / `当前“需要你”列表没有项目。` | `沒有要你回的事` / `Nothing needs you` / `没有要你回的事` | Empty `.needs-sheet` (paired with `.sync-btn` freshness) |
| 6 | `pgNothingHint` | `代理程式問你問題或卡住時，會顯示在這裡，分頁標題也會顯示數字。` / `When an agent asks you something or gets stuck, it shows up here, and the tab title shows a number.` / `代理问你问题或卡住时，会显示在这里，标签页标题也会显示数字。` | **Removed** (no sentence explaining how the board works) | Removed |
| 7 | `pgNoWorking` | `過去 30 分鐘沒有代理程式有動作。` / `No agent has done anything in the last 30 minutes.` / `过去 30 分钟没有代理有动作。` | `沒有進行中的工作` / `Nothing running` / `没有进行中的工作` | `進行中` view empty state (omitted in `需要你`) |
| 8 | `pgQuietAsking` | `現在沒有代理程式在工作。它們問你的事在「需要你」裡（{n}）。` / `No agent is at work right now. What they asked is under Needs you ({n}).` / `现在没有代理在工作。它们问你的事在“需要你”里（{n}）。` | **Removed** (redundant when `需要你` is already shown) | Removed |
| 9 | `pgQuietStopped` | `現在沒有代理程式在工作。{agent} {minutes} 分鐘前還在做。` / `No agent is at work right now. {agent} last worked {minutes} min ago.` / `现在没有代理在工作。{agent} {minutes} 分钟前还在做。` | **Removed** (AI name in sentence; stopped work sits in `已停止`) | Removed |
| 10 | `pgNoQuestions` | `{name} 在目前「需要你」清單沒有項目。` / `{name} has no items in the current Needs you list.` / `{name} 在当前“需要你”列表没有项目。` | **Unified filter/search empty line** -> `找不到「…」` / `Nothing matching "…"` / `找不到“…”` (or `沒有符合的項目` / `Nothing matches` / `没有符合的项目`) + `[✕ 清除]` / `[✕ Clear]` / `[✕ 清除]` | Filtered empty state |
| 11 | `pgNoQuestionsElsewhere` | `{name} 沒有要你處理的；其他地方還有 {count} 項在等你。` / `{name} has nothing for you; {count} more wait elsewhere.` / `{name} 没有要你处理的；其他地方还有 {count} 项在等你。` | **Removed** (AI name in sentence; sidebar gold badges and `.pulse-bar` already show counts elsewhere) | Removed |
| 12 | `serveCodexCopyHint` | `看板還不能傳訊息到這個 Codex 對話：請複製訊息、貼到 Codex，你在那裡送出後 Codex 就會讀到。` / `The board can't send to this Codex conversation yet: copy the message, paste it into Codex, and Codex reads it when you send it there.` / `看板还不能发消息到这个 Codex 对话：请复制消息、粘贴到 Codex，你在那里发送后 Codex 就会读到。` | **Micro-pill:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `看板還不能直接傳送到這個對話；按複製後貼到視窗送出` / `Direct send is unavailable for this chat; copy and paste into its window` / `看板还不能直接发送到这个对话；点复制后贴到窗口发送` | Item micro-pill + tooltip (disappears once delivery lands) |
| 13 | `serveCodexResumePrompt` | `在電腦上續接這個 Codex 對話，再於 Codex 送出一次提示以重新連線。連上後再從那台電腦的看板傳送；只重新開啟對話還不會連線。` / `Resume this Codex conversation on the computer, then submit one prompt in Codex to reconnect. Once connected, send from the board on that computer; reopening alone does not reconnect it.` / `在电脑上恢复这个 Codex 对话，再在 Codex 中发送一次提示以重新连接。连接后再从那台电脑的看板发送；仅重新打开对话还不会连接。` | **Micro-pill:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `需在電腦重新連線後才能直接送出；可先複製續接指令` / `Reconnect in the terminal on the computer to send directly; resume command inside` / `需在电脑重新连接后才能直接发送；可先复制续接命令` | Item micro-pill + tooltip; resume command stays inside opened detail |
| 14 | `serveLineNone` | `{agent} 還不能從看板收訊息：請複製後貼到它的對話裡。` / `{agent} can't receive messages from the board yet: copy this and paste it into its chat.` / `{agent} 还不能从看板收消息：请复制后贴到它的会话里。` | **Micro-pill:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `貼到它的對話視窗送出` / `Paste into its chat window to send` / `贴到它的对话窗口发送` | Item micro-pill + tooltip |
| 15 | `serveSendOpen` | `{agent} 沒有連上這個看板。請複製後貼到那邊。` / `{agent} isn't connected to this board. Copy this and paste it there.` / `{agent} 没有连上这个看板。请复制后粘贴到那边。` | **Micro-pill:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `尚未連上看板 · 回覆需貼上` / `Not connected to board · paste replies` / `尚未连上看板 · 回复需粘贴` | Item micro-pill + tooltip & disconnected sidebar row tooltip |
| 16 | `serveSendNone` | `{agent} 收不到這裡傳的話：複製後貼到它的對話。` / `{agent} can't take a message from here: copy it and paste it into its chat.` / `{agent} 收不到这里发的话：复制后贴到它的对话。` | **Micro-pill:** `需貼上` / `Paste to send` / `需粘贴` · **Tooltip:** `這個對話無法從看板收訊息；請複製貼上` / `This chat cannot receive from the board; copy and paste` / `这个对话无法从看板收消息；请复制粘贴` | Item micro-pill + tooltip |

Related follow-up tightenings (same rule, outside the 16 primary cuts):
- `serveLineUnrecorded`, `serveLineStateUnknown`, `serveLineShadowed`, `serveManualReply`, and `serveLanSend` also collapse from multi-sentence card copy into the `需貼上` (`Paste to send` / `需粘贴`) micro-pill with their exact AI-name-free reason in `[data-tip]`.
- `answeredHide` (`已回覆，先隱藏` / `Already answered, hide` / `已回复，先隐藏`) shortens to `隱藏` / `Hide` / `隐藏` (`28×28 px` eye-off icon button with `aria-label` + `[data-tip]` on desktop detail/rail; `44 px` icon + `隱藏` button on phone `.sheet`).
- **Preserved untouched (plan B4):** `傳送中` -> `已送達` -> `已回覆`, `不確定 · 看它的視窗`, and `未送達` keep their exact words and semantics.

### 2. The `需貼上` micro-pill and tooltip

- When a waiting item or session cannot accept a direct reply from the board, the item no longer renders a 2–3 line explanatory paragraph inside the row body.
- Instead, line 2 `.acts` (and the opened detail header) shows a compact micro-pill `需貼上` (`Paste to send` / `需粘贴`) with a leading `12 px` clipboard-arrow icon, tinted with `--paste-bg` (`#FEF5DC` light) / `--paste-line` (`#E9C46A`) and `--waiting-text` (`#8A5200`, `>= 5.8:1` light and `>= 4.5:1` across light & dark).
- Hovering (`@media (hover: hover) and (pointer: fine)`) or keyboard-focusing (`:focus-visible`) reveals an instant CSS `[data-tip]` bubble carrying the exact AI-name-free reason, right-anchored on trailing controls so tooltips never cause horizontal overflow.
- Once live delivery lands for that surface, the `需貼上` micro-pill disappears without leaving dead copy behind.

### 3. The action row and micro-controls (<= 3 controls, no 1-char wrapping)

- **Folded desktop item (`>= 640 px`):** line 2 shows `>_ CLI`/`❐ App` `.surf-pill` + `project · age` on the left, and at most **3 controls** right-aligned in `.acts` (`13 px`):
  - **Connected `ask`:** up to **2 choice pills** (`[ECMWF]` `[本地模型]`) + a **`26×26 px` compose icon button `.ib-sm`** (`aria-label="自訂回覆"`, `data-tip="自訂回覆"`, replacing text `回覆`) that opens the inline or rail composer.
  - **Paste-only `ask`:** **`需貼上` micro-pill** (`12 px` clipboard-arrow icon + `需貼上` + reason tooltip) + **choice pill with `12 px` copy icon prefix** (`[📋 好]` instead of verbose `複製「好」`, `aria-label="複製回覆：好"`, `data-tip="複製「好」"`) + **`26×26 px` `.ib-sm` compose icon button** (`<= 3` controls total).
  - **Hand-kept `mine`:** leading round check `.chk` on line 1 + a 1-click **`26×26 px` `.ib-sm` Copy Command icon button** (`data-act="copy-cmd"`, `aria-label="複製指令"`, `data-tip="複製指令"`) right-aligned on line 2 whenever `cmd` is present.
- **Detail & Rail secondary actions:** `.rail .r-head` and inline `.d-head` render `[AI SVG tile] + [>_ CLI / ❐ App badge] + [project · age]` (dropping typed vendor names so project names do not truncate on `320 px` rails). `封存` (`archive` box SVG) and `隱藏` (`hide` eye-off SVG) render as **`28×28 px` `.ib` icon buttons** with `aria-label` + `[data-tip]`, placed inside `.r-head` on the **`320 px` detail rail** (`>= 1440 px`, without repeating `.more` below) and inside `.more` on inline opened detail (`< 1440 px`). On phone (`< 640 px`) `.sheet`, **`44 px` touch buttons** keep the icon + short 2-char label (`封存` / `隱藏`).
- **Filter chips:** `AI`, `專案`, and `介面` multi-select chips carry leading **`12 px` category SVG icons**, paired with a compact **`[✕ 清除]` reset pill** (`12 px` `✕` icon + `清除`) when search or any filter is active.
- **No label squeezing:** `.acts` uses `flex: none` and buttons use `white-space: nowrap; flex: none` (minimum horizontal padding `10 px`, height `26 px` for text pills, `26×26 px` for `.ib-sm`). Labels never collapse to 1 character per line at `1280 px` or `375 px`.
- **Phone (`< 640 px`):** inline `.acts` are hidden on folded 2-line items so the question and `CLI/App · project · age` never fight for horizontal room; tapping the row opens the bottom sheet with `44 px` touch buttons.

### 4. Command shown once, on open

- A task's command (`$ claude -p "/progress connect"`, or resume command) is **removed** from the folded item's title/body prose so commands never repeat the title.
- Full command text renders **once**, inside the opened detail view (inline `.d` below `1440 px`, **`320 px`** right-hand `.rail` at `>= 1440 px`, or `.sheet` on phone `< 640 px`), in a single horizontally scrollable `.cmd` strip with a copy icon button (`aria-label="複製指令"`, `data-tip="複製指令"`).
- When a hand-kept `mine` item carries a `cmd`, its folded line 2 exposes only the `26×26 px` `.ib-sm` Copy Command icon button (`data-act="copy-cmd"`, `aria-label="複製指令"`).

### 5. `[📦 全部封存]` pill in `已停止` header

- The 7-control `批次封存` (`tidy-bulk`) form (`<select>` kind + text input + Preview + Confirm + Cancel) at the bottom of the page is **removed**.
- A compact icon+label pill button **`[📦 全部封存]`** (`24 px` height, `12–13 px` archive-box SVG + `全部封存` / `Archive all` / `全部归档`) sits right-aligned inside the `已停止` fold header (`#sec-stop`).
- Pressing `[📦 全部封存]` archives all currently matching stopped items immediately (optimistic UI) and surfaces the 8-second toast `已封存 N 項 · 復原` (`Archived N · Undo`).

### 6. Icon-only sidebar AI rows, surface badges, and gold badge priority (finding 5)

- Sidebar `#ai-list` rows show `[22×22 px official monochrome AGENT_ICONS SVG tile] + [>_ CLI / ❐ App .surf-pill micro-badges] + [gold badge / 4-shape status dot]` with **zero visible AI name text** and never print status words like `正在做` or `等你回覆`. Full descriptive `aria-label` stays for screen readers (e.g. `Claude · App · 1 件需要你`), while hover `[data-tip]` stays AI-name-free. When an AI has both `CLI` and `App` sessions active, both distinct surface badges (`>_ CLI` recessed stone vs `❐ App` soft Ai-iro tint) render cleanly side-by-side. Vendor names remain **only inside the `[AI ▾]` filter dropdown checklist**.
- Right-hand indicator precedence per AI row (encoding presence by **shape + colour**, with **zero AI names** in tooltips):
  1. **Waiting on the person (`n > 0`):** Luminous Yamabuki gold count pill (`.badge`, `--waiting-fill` / `--waiting-on`, the one loud colour on the page) — **overrides** any concurrent running indicator so a waiting question is never hidden behind "working" (fixes finding 5). Tooltip: `1 件需要你 · 另有進行中任務` (`1 needs you · work also running`) when also working, or `N 件需要你` (`N need you`) — never `Codex · …`.
  2. **Running (`n === 0` and active task):** solid green circle (`.st.run`, `8×8 px`, `--done`), tooltip `進行中` (`Working`).
  3. **Open, idle (`n === 0`, connected, not running):** hollow green ring (`.st.open`, `8×8 px`, `1.5 px` `--done` stroke), tooltip `開著 · 無待辦` (`Open · nothing waiting`).
  4. **Not connected:** receded row (`.ai-row.is-off` using `color: var(--muted)` + `.mk { opacity: 0.65 }` so text and `[data-tip]` bubbles keep `>= 4.5:1` contrast) + muted horizontal dash (`.st.off`, `8×2 px`, `--muted`), tooltip `尚未連上看板 · 回覆需貼上` (`Not connected to board · paste replies`) — never `Cursor 尚未…`.

### 7. All board states

| State | Visual & copy contract |
|---|---|
| **Empty (`需要你` = 0)** | Corner Light shifts to `is-working` or `is-idle` (calm ink tab icon); swallowtail `.flag` recedes to neutral `.flag.calm` (`需要你 0`, zero gold on page); `.needs-sheet` shows `沒有要你回的事` (`14 px` / `600`) while `.sync-btn` (`[↻ 剛剛]`) in `.pulse-bar` / `.m-top` shows freshness. |
| **Stale (`#1023` / 2 min no update)** | Corner Light enters `is-offline`; `.sync-btn` transforms in-place into high-contrast amber warning pill **`[⚠ 2m · 重整]`** (`>= 4.5:1` in light & dark, spinning & refreshing on click — no full-width prose banner) while `.needs-sheet` and `.list` dim to `opacity: 0.55`. |
| **Large storage (`> 512 KB` / multi-MB)** | Zero banner, zero red alarm, zero Settings storage line (`boardLarge`, `progressLarge`, `storeLarge` all removed; tidying runs on its own and the page speaks only if a write fails). |
| **Nothing found (search or filter)** | Single line `找不到「{query}」` (or `沒有符合的項目` for chip-only filters) + `[✕ 清除]` reset pill. |
| **AI not connected** | Sidebar row recedes (`.ai-row.is-off` with `color: var(--muted)` + `.mk { opacity: 0.65 }`, `8×2 px` `.st.off` dash, preserving `>= 4.5:1` text and tooltip contrast) with AI-name-free tooltip (`尚未連上看板 · 回覆需貼上`); its waiting items carry the `需貼上` micro-pill + tooltip. |

### 8. Phone (`P9`, `< 640 px`)

- **Top bar (`.m-top`, sticky):** `24×24 px` `.ab-icon` Corner Light mark (live `is-waiting` / `is-working` / `is-idle` / `is-offline`), search input (`36 px` height, `16 px` font to avoid mobile zoom, `/` or tap), compact `.sync-btn` (`[↻]` normal / `[⚠ 2m]` amber stale pill, `min-height: 36 px`), and Settings icon button (`44×44 px` hit target).
- **AI strip (`#m-ai` / `.m-ai`):** sideways-scrolling chips (`scrollbar-width: none`, edge fade) showing `[全部]` + compact icon chips `[20×20 px official monochrome AGENT_ICONS SVG] + [>_ / ❐ icon-only surface pill(s)] + [gold .badge when n > 0]` with **zero visible AI name text** (full descriptive `aria-label` stays for screen readers, receded when disconnected; desktop `#ai-list`, item rows, and phone `.sheet .r-head` keep full `>_ CLI` / `❐ App` text+icon pills) — allowing `[全部]` + all 4–5 AIs to fit cleanly on `375 px` without clipping.
- **View tabs (`.m-tabs`, sticky):** segmented 3-tab bar (`role="tab"` with `aria-selected`) for `需要你` (with gold count badge when `n > 0`), `進行中` (with count), and `全部`.
- **Compact jump pills (no `#m-glance` prose):** replaces prose `#m-glance` under `.needs-sheet` in `需要你` view with quiet icon+count pills (`[▸ N] [■ N] [✓ N]`, `tabular-nums`, zero prose words) for 1-tap jumps to `進行中`, unfolded `已停止`, and unfolded `已完成`.
- **Folded items:** same 2-line density as desktop (`>_ CLI`/`❐ App` `.surf-pill` + `project · age` on line 2) without folded `.acts` buttons; `進行中` rows drop the progress bar and project column, keeping `1/3` and `age`.
- **Bottom sheet (`.sheet` + `.scrim`):** slides up with `overscroll-behavior: contain` (`visibility: hidden` + `inert` when closed so offscreen controls leave Tab order); `.sheet .r-head` shows `[AI SVG tile] + [>_ CLI / ❐ App badge] + [project · age]` (no typed vendor name), `16 px` title, context, steps, `.cmd` strip (once, with `44×44 px` `.ib` copy button), **44 px** answer choice buttons (`.sheet .big .btn`, `min-height: 44 px; height: 44 px`), `自己寫` textarea (`16 px` font to avoid mobile zoom) + `送出` (`min-height: 44 px`), and **`44 px` touch buttons keeping icon + short 2-char label** (`封存` / `隱藏`).

### 9. `#1023`'s first line — Compact interactive pulse & freshness pill bar (`.pulse-bar`)

- Replaces all three prose summary lines — top `4 件等你 · 2 進行中 · 本週完成 1`, bottom `進行中 2 · 已停止 2 · 已完成 1 · 看全部 ›`, and phone `#m-glance` — with **one compact, right-aligned cluster of icon+count pill buttons (`.pulse-bar`)** beside the filter chips (`tabular-nums`, `28 px` height, `13 px` SVG icon + count only, `aria-label` + instant `[data-tip]` tooltip):
  - **`[● N]` Needs-you pill (`jump-needs`):** shown outside `需要你` view when `N > 0`; 1 press jumps straight to `需要你`.
  - **`[▸ N]` Working pill (`jump-run`):** switches to `進行中` (`aria-label="進行中 N 項"`).
  - **`[■ N]` Stopped pill (`jump-stop`):** opens `全部` with `已停止` (`#sec-stop`) unfolded and scrolled into view (`aria-label="已停止 N 項"`).
  - **`[✓ N]` Done-this-week pill (`jump-done`):** opens `全部` with `已完成` (`#sec-done`) unfolded and scrolled into view (`aria-label="本週完成 N 項"`).
  - **`[↻ 剛剛]` Freshness / sync button (`.sync-btn`):** spins and refreshes on click (`aria-label` + `[data-tip]`).
- **In-place stale / poll-failure state (no prose banner):** when polling fails past budget or the board has had no update for 2 minutes, `.sync-btn` transforms **in-place** into a high-contrast amber warning pill **`[⚠ 2m · 重整]`** (`--waiting-text` >= `4.5:1` in light & dark) while `.needs-sheet` and `.list` dim to `opacity: 0.55` (and Corner Light enters `is-offline`), without inserting a full-width prose banner.

### 10. Keyboard triage rules

| Key | Context | Action |
|---|---|---|
| `/` | Not typing in `<input>` / `<textarea>` | Focuses search (`#q` on desktop, `#mq` on phone); `e.preventDefault()`. |
| `Esc` | Anywhere | Closes/clears in order: (1) blur input (and clear search if non-empty and focused), (2) close open filter menu, (3) close `320 px` detail rail (`S.sel`), inline opened item (`S.open`), or phone bottom sheet (`S.sheet`). |
| `j` / `↓` | Not typing | Moves keyboard focus to the next item row (`.it-r` / `.row`) in the visible list. |
| `k` / `↑` | Not typing | Moves keyboard focus to the previous item row. |
| `Enter` | Focused on an item row | Opens/selects that item (inline detail `< 1440 px`, `320 px` detail rail `>= 1440 px`, bottom sheet `< 640 px`). |
| `Space` | Focused on an item row | For a hand-kept `mine` item, marks it done (with 8 s `復原` toast); otherwise toggles open/select, preventing page scroll. |

### 11. References (patterns only, never product look or brand)

- **T3 Code** (`pingdotgg/t3code`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`, `Sidebar.tsx`, and `packages/client-runtime/src/state/threadSearch.ts`):
  - Per `#209` (`7154088026`), T3 Code hosts new sessions while Agent Board triages sessions already running across external CLIs and desktop apps; only structural list ergonomics are borrowed:
  - Two-line compact row anatomy (`min-w-0 flex-1 truncate` title, leading provider/status mark, right-aligned `tabular-nums` relative timestamp).
  - Hover/focus tooltip (`SidebarThreadTooltip`) carrying secondary environment/connection diagnostics instead of multi-line prose inside the row.
  - Visual recession (`opacity` + muted/grayscale treatment via `shouldRecedeSidebarThread`) for settled or disconnected entries.
  - Stable search ranking/display while typing (`visibleThreadSearch` / `nextShownOrder` preventing row flicker) and `Enter`/`Space` row activation.
- **Claude Code (`claude agents`)**:
  - Explicit state model separating `running`, `waiting` (with `waiting_for` reason such as `permission_prompt` / `user_question`), `completed`, and `failed` — motivating Redesign 2's strict rule that a waiting state (`n > 0` gold badge) always overrides a concurrent `running` dot in the sidebar (finding 5).
- **Linear inbox & mail clients**:
  - Single-column triage list (`<= 760 px`) with an optional wide-screen side detail rail (`320 px` at `>= 1440 px`, within `#1849`'s `<= 340 px` cap), `j`/`k`/`Enter` keyboard loop, optimistic removal with an 8 s `Undo` toast instead of confirmation dialogs, and header-level `Archive all` replacing multi-field bulk forms.
- **GitHub notifications inbox**:
  - Icon-only monochrome provider marks (reserving vendor names solely for the `[AI ▾]` filter dropdown checklist) paired with distinct `>_ CLI` / `❐ App` surface badges, luminous gold waiting counts, folded secondary shelves (`等別人`, `已停止`, `已完成`), multi-select filter chips with item counts + single `Clear` reset, and query-echoing empty results (`找不到「…」`).
- **The 4 design skills**:
  - `impeccable`: 4-pt spatial scale (`--s1`–`--s7`), 4-step type scale (`12/13/14/18 px`), Ai-tinted pale washi mist & Luminous Yamabuki light / Inkstone dark tinted neutrals verified `>= 4.5:1` WCAG AA across light & dark (`>= 9.4:1` AAA on `.flag` / `.badge`), hairline list rows inside `.needs-sheet` without nested cards, zero `border-left > 1px` or gradient-text AI tells, and concise UX writing ("make every word earn its place").
  - `web-design-guidelines`: `:focus-visible` outlines, `tabindex="0"` focusable item rows (`role="button"` + `aria-expanded` on button-free `.row` items; `aria-expanded` on `.ib-sm` reply disclosure inside `.it-r` rows to avoid nested `role="button"` or `aria-expanded` on generic `<div>`), `role="group"` filter popovers, `aria-current` / `aria-pressed` filter state, `aria-selected` on phone `role="tab"`, `inert` + `visibility: hidden` offscreen `#sheet`, `aria-live="polite"` toast, `tabular-nums`, `min-w-0` truncation guards, `overscroll-behavior: contain` on the bottom sheet, `16 px` mobile search and textarea inputs, and `prefers-reduced-motion` support.
  - `emil-design-eng`: zero animation on frequent keyboard triage (`j`/`k`/`/`/`Esc`), snappy `140–240 ms` `ease-out` / drawer transitions (`180 ms` exit, `240 ms` enter) and `transform-origin: top left` filter popovers using `transform` and `opacity` only, subtle `scale(0.97)` `:active` press feedback, and `@media (hover: hover) and (pointer: fine)` hover gating.
  - `critique`: Nielsen's 10 heuristics and cognitive-load cap (`<= 3` folded controls per item, `<= 4` visible options at any decision point).

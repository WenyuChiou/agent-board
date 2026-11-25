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

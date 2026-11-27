# Plan for 0.26.0, draft 2: the mainstream AIs work end to end

Written 2026-11-24 for the owner's review. **In force:** the owner approved it on #1837 (2026-11-24); later decisions are in section G. It revises draft 1 (Fable 5.2) after two adversarial reviews (Opus: accept with changes, 12 must-fix; Codex Sol: reject, 13 must-fix) and the owner's decisions of 2026-11-24, late (#209 comment 7149125740). Each must-fix was checked in the code at `origin/main` `8bbe938f` or in its issue before it was taken (appendix).

**Fixed inputs.** (1) 「記住這一次0.25.2 一定要把主流AI的 全部功能實現好」: the next release makes every function work for the mainstream AIs: the Claude Code CLI and desktop app, the Codex CLI and app, the Antigravity app and `agy`, DeepSeek Harness (its terminal moves to 0.26.1 by the owner's decision of 2026-11-27, C below; its Web surface stays a regression row). The board opens, a question is one card, the reply goes in, the status is correct and timely. (2) Mainstream first: the self-update (U1 to U4, #1819 to #1822) moves to the release after. (3) The routes change hooks and R7 bars a hook change in a patch, so the release is **0.26.0**. It absorbs the no-hook part of milestone 17; there is no separate 0.25.2 unless the owner says so; the next release is 0.27.0. (4) Still in force: desktop apps and CLIs, no VS Code extensions (7147735354); every supported AI takes a reply, never Copy (principle 3); our own delivery design; in the UI, order and layout first, then the card, then wording (7148340095).

**Words.** *Shape S*: an install set up by `setup`. *Shape P*: an install wired by the Claude Code plugin's connector, as the owner's is (sitting record, "Where it runs"). *Goes in*: a turn in that session carries the answer. *Hook change*: as R7 says, checked by `tests/hook-declarations.test.mjs`.

## What changed from draft 1

**Owner decision, 2026-11-27 (C):** the owner answered "Accept C" to the 11-26 workflow review (Claude Fable 5.2, Gemini Carbon, GPT Astra 6.2). C has four parts. (1) The three app surfaces' "reply goes in" lines come first: L5 (Codex app, spike S3), L6 (Antigravity app and `agy`, S2) and L7 (Claude desktop, reply, S1). (2) Search and filters (P5, issue N11) ship if ready, like N15: they leave L11's must-ship issues and are not counted in the size. (3) DeepSeek's terminal (L8: #686, #1449, #1457, and spike S4) moves to 0.26.1; if its change turns out to change a hook, R7 bars it from a patch and it goes to 0.27.0. DeepSeek Harness's Web surface stays a regression row in 0.26.0; its desktop surface and Cordis CLI stay frozen with the other hosts (G, question 1) until S4 runs in 0.26.1. (4) F5 is dropped: the board never hosts or starts sessions. A surface whose route fails (most likely the Codex app, if S3 finds no typing signal) ships as a named FAIL and goes to the next re-plan; there is no hosting spike. Must-ship is now 52 issues (E4, Size).

**Added by the PM after round 2, at the owner's word (2026-11-24):** the page goes first (「另外UI應該要先行優化 你可以先做這部分優化的設計」), so the layout the owner named is must-ship and lane P starts on day 1 (D, P5 to P7, three new issues; P5 ships if ready since 2026-11-27); and how the PM tests the release (owner: "Add it to the plan"), with a matrix runner as a new issue (E6a). Must-ship: 55 issues (56 since 2026-11-26, with #1890; 52 since 2026-11-27, C above).

**Round 2:** one must-ship list for 0.26.0, U1 to U4 to 0.27.0 (section 1). Cell c passes only if the answer goes in; a failed spike goes to the owner (section 2). C1 per host, with the smallest repair a test shows (C). One rule for who owns a message, and a status line tied to message, session, turn and question (B3, B4). DeepSeek's terminal gets code (moved to 0.26.1, 2026-11-27). An owner app session in week 1. A Done-when, a test and a hook status per line (E3). RELEASING.md's gate in full (E6). 51 issues, not 25. New owner questions (G).

---

## Part 1. Brainstorm (shortened; draft 1's reasoning stands where not changed)

**Hypothesis.** On each supported surface a person opens the board, sees a question as one card, answers on the board and has it go in, and trusts the status. In the owner's sitting no surface did all four (`docs/validation/2026-11-25-parity-0.25.1-sitting.md`).

**Strongest objections, and what they change.** Nothing known starts an idle Codex app thread from outside: Codex keeps one writer per thread, and `codex://threads/<id>` brings the thread forward with no text (the PM's reading of T3 Code and similar projects, 2026-11-24): so route H, shown safe first (S3), or the owner decides (Q3). The routes called Verified ran on shape S, the owner works on shape P: a per-host check (C0) before any repair. A reply queued and never taken looks like one that arrived: one status line that reads Unsure past a fixed limit (20 s on a "now" route). Vendor doors are private or preview: each behind a version check. A five-week plan was cut on day 6 before (E2.1): hook work first, a checkpoint every five days.

**Options.** A, the board hosts every session (T3 Code), and D, Agent Client Protocol: no, a session already open in a vendor's app gets nothing (principle 7, "focus"). B, host new sessions only: no (owner, 2026-11-27: the board never hosts or starts sessions; F5 is dropped). C, polish the words: fails decision 1. E, type into the app's window: can land in the wrong window. G (new), the agent waits on the board itself (`--wait-message`, MCP `board_wait`, `docs/dev/universal-messaging-roadmap.md:91-92`): the agent must choose to call it, so a question at turn end has no one waiting; not built (#722, #685); a candidate for `agy` in S2. **Chosen, F:** per surface, the best of a vendor's door, our turn-end wait (H) and the next-turn mailbox. The board observes; it does not host.

---

## Problem, goals, non-goals

**The problem.** In the sitting every app opened the board; no app took a reply from the page; Codex and Cursor showed two cards for one question; the Claude desktop app showed none; two board copies closed each other's page three times. Answering took five steps: read, pick, Copy, switch window, paste and Enter.

**Goals.**
- G1. On each supported surface (A1), on shapes S and P: the board opens in 1 step; one question is 1 card within 5 s of the turn's end; a press goes in; the status line is right and no older than its budget.
- G2. Steps to answer a waiting question: 5 today, **2 after** (read, press) on every surface that passes c. A surface that needs more is a FAIL (section 2).
- G3. Zero Copy presses and zero board restarts in the owner's end sitting.
- G4. At 1280×800 the first screen shows every waiting question with no scroll, at five waiting.

**Non-goals.** Hosting sessions. VS Code extensions. New routes for frozen hosts (Q1). DeepSeek's terminal (0.26.1). Agent sending and the MCP route (0.27.0). The self-update (0.27.0). The phone as a way in (the cloud bridge); the page's narrow-width layout ships if ready (P9). Card design and wording beyond what is ready (D).

---

## 1. The release shape

**0.26.0 must-ship: 52 issues.** 17 are milestone 17's no-hook part, 21 come from milestone 15, 13 are new (E2), and #1890 (the Antigravity app wake within about 3 s) was added on 2026-11-26. Since 2026-11-27 (owner, C) #686, #1449 and #1457 are in 0.26.1, not here; N11 and N15 ship if ready and are not counted. E3 lists them by line.

**Kept from milestone 17,** as each issue and plan-0.25.2 say: #1650, #1779 (the token leaves the chat; T1 then T2); #1812 (with U1 gone, 0.26.0 must not ask about a daily check it lacks); #1796, #1773, #1553, #1813, #1814 (Codex's card); #1823 (H1), #1824 (H2); #1830, #1831, #1836 (pulled in by the owner); #1657 (the 0.25.1 sitting; closes when its pending rows run in week 1); #1825 (baseline 0.25.1, still the last release); #1826 (F10 rerun); #1827 (first-try green, for the 0.26.0 tag).

**Moves to 0.27.0,** with the rest of milestone 15 that E1 defers: U1 to U4 (#1819 to #1822), and what only serves them: #1727 (its `ready` was held until U3 merges) and the J11b journey of #1313 (J11a stays).

**Moves to 0.26.1** (owner, 2026-11-27, C): DeepSeek's terminal, that is #686, #1449, #1457 and spike S4 (E1, L8). If its change turns out to change a hook, R7 bars it from a patch and it goes to 0.27.0. #1870 (the DeepSeek receiver gives a held claim back while its session works), added to milestone 15 after this plan, moves with them; the milestone is "0.26.1 DeepSeek's terminal".

**Milestone 17's other issues continue as they are.** Already claimed or `ready`: #1773 (PR #1811), #1814 (claimed), #1825 (claimed), #1826, #1830 and #1831 (`ready`), #1836 (its re-check is pending). The ships-if-ready ones keep plan-0.25.2's M6 order: #1656, #1313 (J11a), #851, #1798 to #1802, #1789, #1752, #1720, #1642, #1768, #1808, #1810, #1804, #1786, #1746, #1249, #1316, #1507, #810, #865, #868.

**After this plan merges** (owner: milestones are re-cut "only after it merges"): milestone 15 takes milestone 17's issues except those moving to 0.27.0, and its description names the 52 must-ship issues; a 0.26.1 milestone takes #686, #1449 and #1457; a new 0.27.0 milestone takes U1 to U4; milestone 17 closes with no release.

**What the move costs.** 0.26.0 does not arrive by itself. On shape S: learn, one command, one answer (plan-0.25.2, moment 1), plus one approval in Codex's `/hooks` where a Codex hook changed: 4 steps. On shape P: the plugin's update (3 steps, same table) plus that approval: 4. The way back is a typed install of 0.25.1, since `setup` has no rollback (`scripts/codex-local.ts:2422`), so 0.25.1 must still read 0.26.0's message store (Q2). The first update that arrives by itself comes after 0.27.0.

---

## 2. The pass bar

- **Cell c passes only when the answer goes in:** a turn in that session carries it, as its reply or transcript shows, with no Copy and no window switch, within the route's budget.
- **A stopped session takes the answer within about 3 s** (owner, 2026-11-26: 「每一家 AI 都是這樣子，有問題停下來嘛，所以他就是馬上要傳進去，或比如說在三秒就傳進去」). An AI stops when it has a question, and that is when the person answers on the board. So on every supported surface, an idle session with a question waiting starts the turn that carries the answer within about 3 s of the press. This replaces the 10 s budgets in B2 and E3. The live note for each surface records the seconds; a surface whose route cannot reach about 3 s goes to the owner that day, as below.
- **A message to a stopped session with no question is measured the same way** (owner, 2026-11-26). After a turn ends with no question, a person often sends the next instruction from the board. On the surfaces whose idle route is a door (Claude Code CLI, Codex CLI, the Antigravity app; DeepSeek's terminal from 0.26.1) it must start a turn within about 3 s, as an answer does. Route H cannot carry it: H waits only when a turn ends on a question. So on a surface that passes c through H, this row is recorded with its limit named and is not a gate line.
- A card that only says why it could not, or a route that waits for the person's next message in the AI's window, is a **FAIL** on that surface, with its limit named.
- A spike that fails, or a check not run by its day, goes to the owner **that day** (Q3). Since 2026-11-27 (owner, C) a surface whose route fails ships as a named FAIL and goes to the next re-plan; the board does not host or start sessions. The bar is never lowered quietly. A surface that ships on a FAIL says so in the release notes' first lines and in the support table.
- One-time steps (switching on the Antigravity sidecar; approving a changed hook in Codex's `/hooks`) are setup steps, counted once, not per answer.
- Cell d also covers the row: Done is never shown as Stopped (#1832), and a block is not left `waiting` with every step ticked (N2).

---

## A. Supported surfaces

### A1. Today, and what 0.26.0 makes true

Points: **a** open the board; **b** a question is one card; **c** the reply goes in; **d** the status. "P" is the owner's install, from the sitting. "S" is the kept test home.

| Surface | Today | 0.26.0 makes true |
|---|---|---|
| Claude Code CLI | a, b pass (S), but a plain question with no tool call gives no row (diagnosis A2.4). c starts the idle session (S); seconds never written. d: a board message on an open question drops Needs you to 0 (#1579) | b for a plain question; c within about 3 s, measured; #1579 |
| Claude desktop, Code tab | a passes, but the reply carries the page's link (#1650). b **FAIL**: the app's own task list writes no block (#1833). c: no route; the receiver record says it "does not start in a session a program started" (`hooks/receiver-record.ts:5`); C6 never ran | b one card; c by S1's route; the footer opens the page in one click (#286) |
| Codex CLI | a, b pass (S); P row pending. c (S): about 14 minutes (a 10-minute watch, `scripts/codex-receiver.mjs:43`). On P the hooks are reporters that hand nothing over (C1); the daemon receiver starts whatever the shape (`scripts/board-serve.ts:1365-1372`), and whether it ran on P is unchecked | c within about 3 s with the window open, also right after a turn ends (#1652); at step end while it works (#319); on S and P |
| Codex desktop app | a passes. b: two cards (#1829), two rows (#1832). c: Copy only; the card said "Codex 沒有連上這個看板". The shipped route reopens the thread after a full quit (`docs/validation/2026-11-22-codex-app-reopen-live.md`) | b one card, one row; c by route H if S3 shows it safe, else Q3 |
| Antigravity app | a passes, link in the reply, page came up in English. b one card. c: Copy, no Queue button, cause unknown: on P its hooks do run the mailbox code (C1). d: the file stays `waiting` after the last step; Done rows lack Archive and Confirm done | c: an idle conversation starts on a message while the sidecar is on (#1396, PR #1612 reworked); N2 |
| `agy` CLI | a passes (S). b: an `agy -p` question shows a card (#1589). c: next turn only; `agy` runs no sidecar (`docs/MESSAGING.md:186`) | c by S2's route, else Q3 |
| DeepSeek Harness, terminal | No live row. The receiver's surface check knows only `web` (`hooks/receivers/deepseek.ts:28-35`) and its routes allow only Web (`:20-23`), so the terminal falls to Copy | Moved to 0.26.1 (owner, 2026-11-27); nothing changes in 0.26.0. Then: c at once: the terminal is detected and allowed, with a live note (#686 narrowed); one hand-out (#1449, #1457 case 3) |

DeepSeek's Web surface is Verified (2026-11-08) and stays a regression row. Its desktop surface and Cordis CLI are "Proposed, None" in the matrix; S4 checks whether the plugin loads there; it runs in 0.26.1 (owner, 2026-11-27). Until then they are frozen with the hosts below (Q1).

### A2. Outside the scope

- **Claude Code and Codex in VS Code:** not supported, left as is. They share hook files with the CLI and app, so rows may appear; the support table says "may work, not tested". **Copilot in VS Code, Devin Desktop:** out, never connected. **Gemini CLI:** retired (#1327, PR #1337).
- **Cursor IDE and `cursor-agent`, OpenCode, Grok Build, Hermes, OpenClaw, Muse Code: frozen, if the owner agrees (Q1).** Setup still connects them; rows and cards show as in 0.25.x, cards saying "answer in its window"; nothing is removed; no issue for them enters 0.26.0; they leave the gate. The weekly live row (#1824) still runs on every installed CLI as a watch, not a gate line. Freezing narrows principle 4, "every agent, the same way", which changes only by the owner's word (Q1).

---

## B. The delivery design

### B1. Three kinds of route

- **Door.** The vendor's own way to start a turn in the open session the person sees.
- **H, the turn-end hook waits.** When a turn ends on a question and a visible board page has drawn its card, the turn-end hook waits for the press and returns the answer as the turn's continuation. Evidence: one Codex CLI run (`docs/validation/2026-10-20-send-spikes.md:140-160`), where a Stop hook that printed `{"decision":"block","reason":…}` continued the same turn. Claude Code's approval hook (#1678) already waits on the page this way, at most 30 s. H is the only known route into a thread the Codex app holds open.
- **Mailbox.** Stored; the session's next turn-start hook takes it (`docs/MESSAGING.md:53-75`). It cannot answer an idle session, so on its own it fails the bar.

**What is wrong with H.**
- The host shows the turn as running while the hook waits, and its "finished" notice comes late.
- The Stop input has no field that says the person typed (fields at `send-spikes.md:155-156`). Text typed in the app is held and runs as the next turn after the board's answer: two answers.
- L3 blocked only while `stop_hook_active` was false (`:144-146`). A second question in the continued turn gets no H, unless the guard goes and a loop becomes possible.
- The wait crosses four time limits, and all four change for a long wait: the host's `timeout` in its hook file (`hooks/connect-pure.ts:666`); `HOOK_TIMEOUTS` (Codex Stop 10 s, Antigravity 3 s, `hooks/hook-safety.ts:21`, `:27`); the worker's deadline (`:211-212`); its child's kill (`:290-292`).
- A hook killed after its output may have reached the host cannot be "unsent".

**Rule.** H is on for a surface only if S3 finds a host signal that the person typed during the wait; with none, H stays off there and the surface goes to Q3. The wait is capped at 10 minutes (a proposal; S3 checks what the host allows), runs only while a page that drew the card is visible, and ends when that page has been hidden for 30 s. While H holds a turn, the board's row for that session reads 需要你, with the question's age, never 進行中: the host shows the turn as running, and the board must not repeat that (principle 6). S3 item 3 records, with a picture kept out of the repository, what the app's window shows during the wait and when its "finished" notice fires. The 10-minute cap stays as the owner accepted it (Q3); a shorter cap would fail every answer given after it.

### B2. Per surface

| Surface | Idle, a question waits | Working | If the route fails | Hook change |
|---|---|---|---|---|
| Claude Code CLI | Door we have: the plugin's receiver submits the prompt (`hooks/register.tsx:4303`) | At step end, same receiver | — | No |
| Claude desktop, Code tab | S1: the same receiver if it registers there; else the inbox pipe | As idle | Q3 | No for the plugin's receiver; the pipe: S1 says |
| Codex CLI | Door: the daemon's `turn/start` at the next receiver tick (about 3 s), also right after a turn ends, while a Codex terminal process is alive (#1652; owner's decisions 2026-11-18 and 2026-11-26) | The Stop hook hands over at step end (#319) | Q3 | #1652: none expected. #319: none on S (the Stop hook exists with 10 s), on P through L1 (unchecked) |
| Codex desktop app | H, if S3 shows it safe | Stop hook at step end, as the CLI | Q3. Today's after-quit route stays, as a choice | Yes: the Stop limits (B1) |
| Antigravity app | Door: the sidecar calls Antigravity's own `agentapi send-message`, and the turn-start hook hands over (`docs/MESSAGING.md:181-236`). PR #1612 merges with a 10 s wait after the turn's end; #1890 lowers it to about 1 s after a live run (owner, 2026-11-26) | Mailbox: a working conversation starts its next turn by itself (live note 2026-11-13) | Q3 | Yes (the wake, plan-0.25.2 section 2; which line: unchecked) |
| `agy` CLI | S2: H on Antigravity's turn-end hook, or a documented continue command that is not a second writer, or `--wait-message` (G); never a port, token or sign-in | Mailbox | Q3 | Yes if H (the 3 s limit) |
| DeepSeek, terminal | Moved to 0.26.1 (owner, 2026-11-27). Door: the board's plugin calls `Agent.followup` (`hooks/receivers/deepseek.ts:3-7`), once the terminal is detected and allowed | Held until idle | Q3 | Possibly: it lives in the generated plugin (`hooks/portable-agents.ts:135-137`); unchecked. If it changes a hook, R7 bars a patch: 0.27.0 |

**New sessions.** The board hosts or starts none (owner, 2026-11-27: F5 is dropped).

### B3. One rule for who owns a message

Seven things can hand out or answer one question: route H, the receivers (Codex daemon, Claude plugin, DeepSeek plugin, the Antigravity wake), the next-turn hook, two pages, and the person typing in the app.

1. **One message, one id.** The page makes the id at the first press and keeps it for every retry of the same text (`hooks/serve.ts:1877-1879`); the store returns the stored message for a known id (`hooks/messaging.ts:353-357`). A retry never makes a second message.
2. **One open answer per question.** The store keys a board answer by session, turn and question. While one is not settled, a second one (another page, another press) is refused, and that page shows the first one's status.
3. **One claim.** Every route takes a message only through the store's one atomic claim, which names the route and the run. The holder owns delivery; every other route sees it taken and does nothing. Only the holder gives a claim back, and only before its output could reach the host. After that it settles as Delivered or Unsure, never queued again (#1407's rule, in one helper).
4. **H claims at the press, not when it starts waiting.** While it waits it holds nothing, so a route that fires first takes the message as usual and H then returns nothing.
5. **The person's own answer wins.** If the host shows the person typed in the AI's window (S3's signal), H returns nothing and the board's answer is withdrawn: Not delivered, "you answered in its window", text kept. A message whose question the conversation has moved past (a later turn has ended) is refused at claim, as #319 asks; the card offers to send it as a new message.
6. **Never a second turn while one runs.** A door starts a turn only when the host says the session is idle. Background runs refuse a running turn (`docs/MESSAGING.md`, Background resume, limit 3). While H holds a turn open, every other route treats that session as working.
7. **A killed holder.** Killed before its claim: nothing was sent and the message stays queued. Killed after its claim: Unsure, "check its window", never sent again by itself (#319: "a hook killed after its claim leaves the message uncertain").
8. **An older board.** No take falls back to an unnamed claim it cannot give back (#1638). Against such a board the message stays queued and the card says "restart the board".

### B4. The status line

One line under the reply box, the same words on the page, the terminal board (#232) and `--json`. Each state comes from a stored receipt (`docs/MESSAGING.md:313-325`).

| Shown | Means | Tied to | Unsure, or the next step, when |
|---|---|---|---|
| 傳送中 Sending | pressed, no answer from the board yet | the page's message id | no answer in 2 s: "not confirmed, trying again", with the same id (B3.1); after 30 s: "cannot reach the board", text kept |
| 已排入 Queued · when | stored, not handed out. "When" is: now, at its step's end, or at its next turn | message, session | a "now" route: past 20 s, a fixed limit of its own (owner, #1843, 2026-11-25), apart from the about 3 s delivery bar. Step-end and next-turn routes have no clock: the line shows its age and what it waits for; a lapsed mailbox follows #1432. On a "now" route the page keeps 傳送中 on screen until the message is delivered or 2 s have passed, so 已排入 · 現在 shows only when it lasts. A message that waits for a step's end or a next turn offers one action, 收回 (the existing dismiss call, `docs/MESSAGING.md:743`), which frees the session for a new message at once |
| 已送達 Delivered · time | a claim holder handed it out | message, session, the turn it started or continued | the session ends or goes silent with no reply in that turn |
| 已讀 Read | that session's `ACK <code>` line, in that turn | message, session, turn | — |
| 已回覆 Answered · on the board, or · in its window | the turn after the question has started, with the board's hand-over or without it | the question (session and turn) | — |
| 不確定 Unsure · why | claimed with no acceptance; holder died; connection lost; past a budget | message | says "check its window"; never a blind resend |
| 未送達 Not delivered · why | refused, expired, withdrawn, or moved past | message | one action: send as a new message, or open its window |

Read shows only where the route collects an ACK: the Codex daemon, Antigravity (`hooks/receivers/hook-mailbox-antigravity.ts:6-9`, #1416), and the Codex Stop hook at the next Stop (#319). An ACK proves receipt, not that the task was done (`docs/MESSAGING.md:323`). Answered closes the card and is never read from an ACK. A receiver that holds a message says why (#1511, #700). A typed answer survives its receiver going away (#782).

**One send control** (owner, 2026-11-26). The reply box has one button, 送出, on every route. It never changes to 「排入 … 的下一回合」 and never carries an AI's name (today: `hooks/serve.ts:2205`). When the message will land is the status line's "when".

### B5. Spikes, and the owner's app session

All in week 1, except S4 (0.26.1); S3, S2 and S1, the three app surfaces' spikes, run first. Each is a dated note in `docs/validation/`; no key or token is written down (R8).

| # | Who, where | Must prove | If it fails |
|---|---|---|---|
| C0 | Lane, in a shape-P test home; a read-only look at the owner's install in his session | Codex: do the reporters hand anything over; did the daemon receiver run; why "not connected". Antigravity: why no Queue (a session enrolls only if the default messages folder exists, `docs/MESSAGING.md:55`; or the two board copies). Then the smallest repair, by a test that fails, then passes, on P | L1 builds only what C0 shows |
| K-live | Lane: #1652's half-day check | The Codex hook records the terminal's own process (`scripts/session-liveness.ts`) | Codex CLI to Q3 |
| S3 | Lane: Codex CLI. Owner session: the Codex app | (1) the longest wait each host allows; (2) the text continues the same turn, once; (3) what the window shows; (4) a host signal that the person typed during the wait; (5) a kill before the claim and after the output; (6) five runs in a row (L3 failed one start in two); (7) memory and CPU at ten waits | H off there; Q3. Codex app: ships as a named FAIL and goes to the next re-plan; no hosting spike (F5 is dropped, owner 2026-11-27) |
| S1 | Lane: K4, the inbox pipe on Windows. Owner session: the Code tab | (1) the plugin's receiver registers in the Code tab and starts a turn (C6); (2) else the inbox pipe for a session the board did not start, idle and busy, both prompt modes; (3) the model takes the text as the person's answer, not another session's instruction (principle 5) | Q3 |
| S2 | Owner session: the app, sidecar on by his one yes. Lane: `agy` | App: PR #1612's route wakes an idle conversation. `agy`: one of B2's candidates. Reads no Antigravity port, token or sign-in; keeps the person's one yes (`docs/MESSAGING.md:183-189`) | Q3. A route that needs a port or token is dropped |
| S4 | Lane, in 0.26.1 (moved, owner 2026-11-27) | The plugin loads in DeepSeek's terminal; a sign that tells it from Web; the desktop surface and Cordis CLI | Terminal: Q3. Others: frozen (Q1) |
| K1, K5 | Lane, carried | Codex seconds to turn start; ids after restart | #1652 has no baseline |

**A step for the owner: week 1, day 2 or 3, one app session of about two hours.** The PM drives the apps by computer use, as in the 0.25.1 sitting; the owner handles sign-ins, hook approvals and the sidecar switch. Rows: S1's Code tab, S2's app, S3's app, C0's look at his install, and the 0.25.1 sitting's pending rows C6, C8 and #1674. If it has not run by day 5, the three app surfaces go to the owner that day (Q3).

---

## C. The cross-AI core, checked hard

**C1. Two install shapes, per host (corrected).** On shape P the connector writes:
- **Codex and Cursor:** the plugin's reporter command (`hooks/connect-pure.ts:98-101`, `:651-693`), which only writes inbox files. No turn-start or step-end hand-over runs. Codex's daemon receiver is started by the board server whenever a Codex program is found (`scripts/board-serve.ts:1365-1372`; `scripts/board-cli.ts:2323-2327`), whatever the shape.
- **Antigravity (and Hermes):** the installer's worker command (`hooks/connect-pure.ts:795-815`; `hooks/local-agents.ts:72-82`). The worker runs the board (`hooks/hook-safety.ts:290-292`), which reaches `deliverTurnEvent` (`scripts/codex-local.ts:1674-1677`), which hands mailbox messages over at turn start (`scripts/hook-delivery.ts:185-220`). So the mailbox code runs here; Antigravity's Copy-only card has another cause (C0).
- **The fix (L1)** is the smallest repair C0 shows working, per host. Two candidates for Codex: the connector writes the worker command for Codex as it already does for Antigravity (#285), a hook change Codex asks the person to approve once in `/hooks` (`connect-pure.ts:659-660`); or setup takes Codex over and the connector's existing step retires its reporter (`scripts/legacy-connect.ts:194-201`). Draft 1's "one board script, one owner record" is not in 0.26.0 unless C0 shows it causes a mainstream fault; #1831 already stops the two copies closing each other's page. C1 is not the cause of #1831 or #1832; each has its own.

**C2. One question, two cards (#1829).** A question's identity is its session and turn. The `[?]` step is the card; the reply's closing line is its text when no step exists, never a second card.

**C3. One conversation, two rows (#1832).** One block per agent and host-proven session id. A report binds to the session the hooks know, or is refused in words that say the hooks report for it.

**C4. Ghost and stuck.** #155, #1579, the Antigravity `waiting` file (N2); #1137 ships if ready. They share one cause: a card's life is not tied to its turn.

**C5. Never twice.** B3, with #1407 and #1638; #1449 and #1457 (case 3) go with DeepSeek's terminal to 0.26.1; #1773 and #1553 are carried.

**C6. Blind spots.** The simulated user sends nothing real: every session is synthetic. Every receiver test runs against a stand-in host, and none takes its hook files from a shape-P install (L1's test adds one). A host update can break a row between releases (#1824 watches). DeepSeek had no live row. No macOS run.

**C7. Speed.** Dated baselines: 14 minutes from Send to turn start on Codex CLI (0.25.1 parity); 291 file operations per idle poll (#254, ships if ready). Never measured on Claude Code. What sits between a turn's end and its row, by install shape:
- **Shape S, and Antigravity on P:** the hook runs the board script, which writes the block itself. No model call. The cost is the hook's own start on the 2.09 MB script; #1823's 100-run check gives the first number, and it runs in week 2 (E5).
- **Codex on P, today:** the reporter writes an inbox file; an open Claude Code session looks at the inbox every 5 s (`hooks/register.tsx:161`), sums the turn up with a model call of up to 30 s (`:169`, `:2473`), and only then writes the block (`:2502-2513`). The question's card shows earlier, with no model (`scripts/board-cli.ts:315`). L1 removes this for Codex: after it, a Codex turn's state is written with no model call.
- **The page:** it wakes on a change to `progress.md` or the inbox (`scripts/board-watch.ts:21-74`) and on any request to the server (`scripts/board-serve.ts:813`). The message store's folder is not watched, so a receipt a hook writes there shows at the next wake, at most 10 s later (`:133`). L10 adds the watch.
- **Not in 0.26.0:** a hook that posts to the server, and a hook on every tool call. Both change hooks on every host and add a hook run where the hook's start is the unmeasured cost. They come back at the re-plan if #1823's number shows the hook start is over 1 s at the median.

H holds one process per waiting question (S3 item 7).

---

## D. The page: order and layout

**The owner (2026-11-24): 「另外UI應該要先行優化 你可以先做這部分優化的設計」.** The page goes first. The PM's design is `docs/dev/ui-redesign-0.26.0.md`, with a clickable mockup on synthetic data (`docs/dev/ui-mockup-0.26.0.html`). The owner names the order: order and layout first, then the card, then the wording.

**Lane P, page files only:** `hooks/serve.ts` (layout, CSS, page script), `hooks/grouping.ts` (order), and the three string tables, which merge one at a time with the other lanes. It touches no delivery file, so it neither waits on nor holds up a route. It starts on day 1: P1 to P4 merge in week 1, P6 and P7 in weeks 2 and 3, and P5 if ready.

**Must-ship, as the owner named them.**

| # | What | Done when | Test (fails at `8bbe938f`) |
|---|---|---|---|
| P1 | No storage notices | `progressLarge`, `storeLarge`, `boardLarge` (`hooks/i18n.ts:791-793`) never show on the first screen. A size problem is one line in Settings; the page speaks only when a write fails | `tests/page-look.test.mjs`: "a board over every size limit shows no storage notice on the first screen" |
| P2 | No 你的待辦 group | A hand-kept do-now step shows in 需要你 with a round check (pressing it marks the step done) and, on its second line, the mark of the AI session that wrote it (owner: 「放在各家AI的部分」). There is no 你的待辦 group | `tests/grouping.test.ts`: "a hand-kept task is listed under the AI that wrote it; there is no 你的待辦 group" |
| P3 | 需要你: agent questions first | Order: approvals that wait; questions an AI asked; the person's own do-now steps; waits on others folded as "等別人 N". In each, the longest wait first, its age from `updated=`; first seen over 3 days ago folds under "更早 N" (#398's rule). Today cards sort newest first (`hooks/grouping.ts:199-200`, `:426-427`). #269's Done-when is edited to this rule | `tests/grouping.test.ts`: "an AI's question comes before a hand-kept step"; "the oldest waiting question comes first" |
| P4 | The footer flush with the bottom edge | The sidebar footer (version, Settings, close) touches the window's bottom at 1280×800 and at phone width (`.s-foot`, `hooks/serve.ts:1271-1272`) | `tests/browser/confirmed-journeys.test.mjs`: "the sidebar footer's bottom equals the window's bottom" |
| P6 | One work column | The summary column (`hooks/serve.ts:1340`) is gone at every width; the work column is at most 760 px. At 1440 px and wider, a selected item opens in a rail of at most 340 px; below that it opens in place. `Esc` closes it | browser: "at 1280×800 there is one work column and no summary column"; "at 1440×900 a selected item opens in the rail" |
| P7 | Two-line items, smaller type | A folded item is two lines: the AI's mark and the question (14 px, weight 600, one line); then the project, the age and at most three controls (13 px). Opening it shows the task, the context, the steps, a command, 自己寫, 封存 and 隱藏. No text inside an item is over 14 px; the view title is 18 px. AI names leave the sentences (the mark and its tooltip carry them) | `tests/page-look.test.mjs`: "a waiting question's folded item is two lines at 1280 px"; "no text inside an item is over 14 px" |

The reply status on the item uses B4's words and lands with L10, not here.

**Ships if ready, each with its test or not at all.**

| # | What | Done when | Test |
|---|---|---|---|
| P5 | Search and filters (ships if ready, owner 2026-11-27) | One box in the sidebar (`/` focuses, `Esc` clears) for title, project, question and step text. Chips for AI, 專案 and 介面 (CLI or App), each a multi-select menu with counts; 清除 shows while any is on; pressing an AI or project in the sidebar sets the same filter. T3 Code's search (its public source) is read first | browser: "one word finds a card by project name"; "the AI chip set to Codex hides the other AIs' cards" |
| P8 | Undo (#566) | Archive and Confirm done offer Undo for 8 s | #566's five tests, with "Undo refuses with the reason when the block changed after the press" |
| P9 | Narrow width | Below 640 px: search, the AI chips with names and badges, the three views as tabs; pressing an item opens a bottom sheet with its answers as 44 px buttons | browser at 375×812: "pressing a waiting question opens its sheet with its answers" |

Then, if ready: #1023 (first line, live line, folds), #922 (tidying by itself). Step 2 ships only what is ready by week 4: the item's small controls (N15), the 16 strings of Redesign 2, and the choice buttons (#1640, #1500).

---

## E. Triage, lines, order, size, gate

### E1. Milestone 15: 92 open issues (94 with two pull requests)

- **Must-ship (21):** #1829, #1832, #155, #1833 (narrowed to the desktop app; its VS Code line goes), #286, #1652, #319, #1396, #1750, #1751, #1609, #1407, #1638, #1511, #700, #1579, #1432, #782, #232, #269 (Done-when edited, P3), #844 (a tracker: it closes when every 0.26.0 surface's live note exists).
- **Moved to 0.26.1 (3), owner 2026-11-27:** #686 (narrowed to DeepSeek's terminal), #1449, #1457 (case 3; cases 1 and 2 split to Backlog). If the change turns out to change a hook, R7 bars a patch and they go to 0.27.0.
- **Ships if ready (31):** Antigravity #1622 and #1467 (else named limits on its row), #365. Records #1431, #826. Row states #1317 and #398: both change hooks, so in only if merged before the tag. Page #1023, #922, #254, #1014, #1137, #1290, #358, #256. Small: #1452, #1380, #1228, #797, #693, #1790, #1785, #1244, #1245, #1283. #1327 (PR #1337; it removes hook lines, so before the tag or in 0.27.0). Scope: #1321 (F3, F16, F21), #1322 (replaced by E6), #318 (checked against the 2026-11-15 run). Card step 2: #1640, #1500.
- **Later (37).** After Q1, frozen hosts: Cursor #1834, #1793, #1403, #1159, #1025; OpenCode #1795, #1598, #1597, #1379, #1413; Grok Build, OpenClaw, Hermes #1404, #726, #233, #1780. To 0.27.0: approvals and native prompts #1318, #1119, #1320, #1319 (Q4); agents use the board #317, #1372, #1636, #723, #722, #685, #884, #961. Later: #1409, #1613, #866 (0.30.0), #548, #559, #1280. Backlog: #1635, #695, #1696, #1298, #702.
- **Close:** none outright.

### E2. New issues (15), opened after the plan merges

N1 the install repair per host (C0, L1). N2 Antigravity rows: a block leaves `waiting` when its last step is ticked, and Done rows offer Archive and Confirm done (sitting). N3 the Codex desktop app's route (S3). N4 the `agy` route (S2). N5 the Claude desktop app's reply route (S1). N6 the one-owner rule and the status line (B3, B4). N7 no storage notices (P1). N8 no 你的待辦 group (P2). N9 the footer flush (P4). N10 the owner's end sitting for 0.26.0. N11 search and filters (P5; ships if ready, owner 2026-11-27, not counted). N12 one work column and the rail (P6). N13 two-line items and smaller type (P7). N14 the matrix runner (E6a). N15 the item's small controls (D, step 2; ships if ready, about 4 lane-days on lane P; owner, 2026-11-26). Also filed, for Backlog only: #1457 cases 1 and 2; the plugin's saved options lost on reinstall; the Antigravity page coming up in English.

### E3. The must-ship lines

| Line | Issues | Done when (a person can check) | Test or journey that fails without it | Hook change |
|---|---|---|---|---|
| L0 Carried | the 17 of section 1 | each issue's own lines | as each issue and plan-0.25.2 (sections 3, 7) name, among them the late-ACK case in `tests/messaging.test.mjs` | No |
| L1 Install repair | N1 | On shape P, Codex hands a queued message over at turn start and at step end, as on S; on P, Antigravity's card offers Queue and Send; on P, a Codex turn's end writes its state with no model call | `tests/legacy-connect.test.mjs`: "a connector-wired Codex home hands a queued message over at its next turn start"; "a connector-wired Codex home writes a turn's state without a model call"; `tests/e2e/host-journeys.test.mjs`, one row per shape | Codex on P: likely yes |
| L2 One card, one row | #1829, #1832, #155, N2 | One question is one card (Codex app, CLI; Cursor too); one conversation is one row; a `done` block is under Done; no "Still running" on an ended session; the Antigravity block leaves `waiting` | `tests/question-merge.test.ts`: "a `[?]` step and the same closing question in one turn give one card"; `tests/codex-done-lifecycle.test.mjs`: "a skill report and hook turns give one row"; `tests/row-state.test.ts`; each failing at `8ccb458b`, as the issues say | No (N2: unless its fix is in the Stop hook's write) |
| L3 Claude desktop, question | #1833, #286 | In the Code tab a turn with no Task list that ends on a question writes a `[?]` step and shows one card; the footer opens the page in one click | `tests/claude-questions.test.tsx`: "a turn with no Task list that ends on a question writes its block"; a dated live note in the Code tab in week 2 | No |
| L4 Codex CLI | #1652, #319 | Idle, window open: starts within about 3 s, also right after a turn ends. Window closed: does not start. Working: at step end | `tests/messaging.test.mjs`: "terminal alive, thread idle: starts at once"; "terminal gone, thread still listed: does not start"; #319's six tests; a live note with seconds | #1652: none expected; #319: none on S (unchecked) |
| L5 Codex app | N3 | An idle thread with a question takes the board's answer in the same turn within about 3 s of the press, while a visible page drew the card; the person's own typed answer wins; while the hook waits, the board's row reads 需要你, not 進行中 | the B3 cases below, on a stand-in host; "while H holds a turn, the session's row is under Needs you"; a live note on the owner's app | Yes |
| L6 Antigravity app and `agy` | #1396, #1890, #1750, #1751, #1609, N4 | App: an idle conversation starts within about 3 s with the sidecar on; a lock a dead hook left and a dismissed failed wake no longer hold the wake. `agy`: as S2 decides | `tests/antigravity-sidecar.test.mjs`; #1751: "a lock a dead hook left is reclaimed for the poll"; #1609's and #1750's tests; a live note for each surface | Yes (app); `agy` yes if H |
| L7 Claude desktop, reply | N5 | An idle Code-tab session starts a turn on a board answer within about 3 s, labelled as the person's answer sent through the board | `tests/receiver.test.ts` with a stand-in; a live note | No for the plugin's receiver |
| L8 DeepSeek terminal | #686, #1449, #1457 (moved to 0.26.1, owner 2026-11-27; not counted in 0.26.0) | In 0.26.1: the terminal is detected and its idle route is "now", starting within about 3 s; one hand-out; an old agent's end does not reject the new agent's message | `tests/deepseek-receiver.test.mjs`: "a terminal session is detected and starts on a board message"; #1449's and #1457 case 3's tests; a live note | Possibly (B2); if so, 0.27.0 (R7) |
| L9 Never twice | #1407, #1638, N6 | B3's eight rules hold | #1407's test per row; #1638: "a cut or timed-out take on an older board leaves the message queued"; the B3 cases | No |
| L10 Status | N6, #1511, #700, #1579, #1432, #782, #232 | B4 on the page, the terminal board and `--json`. One 送出 control with no AI name; a waiting message offers 收回; a row the board cannot vouch for reads 不確定, with the reason on open; a receipt a hook writes to the store shows on a waiting page within 1 s (owner, 2026-11-26) | `tests/browser/message-receipts.test.mjs`: "a lost response retries with the same id and shows one message"; "a now route with no event for 20 s reads Unsure"; "收回 on a message waiting for its next turn frees the card to send again"; "a receipt a hook writes to the store wakes a waiting page"; `tests/page-look.test.mjs`: "the send button reads 送出 on a next-turn route and names no AI"; "a card that may be closed shows 不確定 and no sentence"; #232's `knownFailure` markers in `tests/e2e/l3b-messaging.test.mjs` flip (terminal); #782's test | No |
| L11 Page | #269, N7, N8, N9, N12, N13 (N11 ships if ready, owner 2026-11-27) | D, P1 to P4, P6, P7 (P5 ships if ready) | D | No |
| L12 Gate | N10, N14, #844 | E6, E6a | E6, E6a | No |

**The B3 cases** (`tests/messaging.test.mjs`, a stand-in host per route): a retry after a lost response, no second message; two pages on one question, one message; H against the next-turn hook, one hand-out; the person types during H's wait, H returns nothing and the board's message is withdrawn; killed before the claim, still queued; killed after the output, Unsure, not resent; the route changes while queued, one hand-out; the host closes during the wait, Unsure; a question the conversation moved past, refused at claim.

### E4. Order, lanes and size

**Lanes** (R2: a risk-tier change is read by another model family): **A, Codex:** L1's Codex part, L4, L5, and the carried #1796, #1773, #1553, #1813, #1814. **B, Antigravity:** L6, N2. **C, Claude:** L3, L7 (L8 moved to 0.26.1). **D, core:** L2 (#1829, #1832, #155), L9, L10. **P, page:** L11 and the page items that ship if ready. **R, records:** the spike notes, #1823, #1824, #1825 to #1827, the sittings, the gate. The token re-cut (#1650, #1779) and #1812 run as plan-0.25.2 says.

| When | Work | Checkpoint |
|---|---|---|
| Week 1 | S1 to S3 first (the three app surfaces: S3 Codex app, S2 Antigravity app and `agy`, S1 Claude desktop), then C0, K-live, K1, K5; S4 is out (0.26.1); the owner's app session (day 2 or 3); Q2 answered; the carried issues continue; lane P starts on day 1 and P1 to P4 merge; the matrix runner (N14) and the baseline run of the 24 cells (E6a) | **Day 5:** every spike has its note. A failed one goes to the owner that day (Q3) |
| Week 2 | L5, L6 and L7 start first, on the notes of S3, S2 and S1; then L1, L2, L3, L4; L9 after Q2; L10 starts; P6 merges (P5 if ready); #1823's timing run (lane R) | **Day 10:** L1 and L2 merged, or the owner gets a new date that day |
| Week 3 | L5, L6, L7 finish (L8 is out, 0.26.1); L10; P7 merges | **Day 15:** every hook-changing line has its pull request in review, or that surface goes to the owner that day |
| Week 4 | Live notes per surface; the declaration list; acceptance tests; ships-if-ready | **Day 20:** every hook change merged. A late no-hook item goes to Q5 |
| Week 5 | The gate (E6): parity, journeys, upgrade, simulated user, outside reads, the owner's end sitting, the release | |

**Size.** 52 must-ship issues, about 87.5 lane-days by line (carried 15.5, L1 4, L2 4, L3 3, L4 5, L5 6, L6 11, L7 5, L9 5, L10 13, L11 9, L12 7; it was 92.5 with L8's 5, which moved to 0.26.1; N11 and N15 ship if ready and are not counted). N11's share of L11's 9 days is not stated anywhere, so the 9 stay. Lane P's 9 days run beside the delivery lanes and do not lengthen the critical path. Five weeks needs five lanes busy from day 1 and fewer review rounds than 0.25.1, whose two spine pull requests took 6 and 7 change requests (#1778, #1783). The diagnosis's pace says less: "the team ships about one week's worth per release … whatever the plan says"; the last five-week plan was cut on day 6 (E2.1). So **five weeks is the owner's target; six to seven is what the pace says.** The date moves; the bar does not.

### E5. If it runs late: the cut order

First to last. Each cut is named in the notes, and a must-ship cut needs the owner's word (R1).
1. Page work that ships if ready (P5, P8, P9, #1023, #922, #254, step 2).
2. #232's pane half (the terminal board's half stays). It goes first if L10 runs over its 13 days (owner, 2026-11-26).
3. Carried no-hook items off the journey: #1823's doctor line, to 0.26.1 (Q5; #1836 merged as a8108327). #1823's timing run (100 hook runs on Windows, with and without the record line) is not cut: it runs in week 2 and its numbers go into C7 (owner, 2026-11-26).
4. P6 and P7, to 0.26.1 (Q5). They are page files only, so a cut here does not bring any route forward; it only frees the date.

**Never cut:** L1 to L7, L9 and L10, except #232's pane half (item 2); P1 to P4 (the owner's page items, about four days); the token (#1650, #1779); #1773, #1553, #1812; the gate issues. A surface whose route fails is not cut: it ships as a named FAIL (Q3, answered 2026-11-27).

### E6. The release gate

**RELEASING.md's gate, with R7, on the tagged commit:** (1) CI green on Ubuntu and Windows; (2) the parity record exists, and every FAIL names an open issue outside the must-ship set; (3) the L1 to L3 journeys and the upgrade journeys (`tests/host-upgrade.test.mjs`) pass; (4) every must-ship issue is closed; (5) the simulated user on Windows and on macOS or Linux, with an issue for every FRICTION. Also RELEASING step 5: every merge on the maintainer route read outside its lane within a day, and any P0 or P1 it found fixed before the last simulated-user run.

**This plan adds,** each bound through a must-ship issue:
6. The declaration test (#1825) has baseline 0.25.1 and lists every hook change E3 marks, and no other.
7. The tag is green on its first try (#1827).
8. The update from 0.25.1 is walked on shapes S and P, each by its own update entry, with the `/hooks` approval counted; the way back, a typed install of 0.25.1, starts a working board that reads the store.
9. A dated live note per supported surface, with seconds from Send to turn start.
10. The support table is generated from those notes; no VS Code column; frozen hosts marked.
11. **The owner's end sitting (N10),** on his install after its update: for each of the six surfaces a, b, c, d, 24 cells, passing as section 2 says. Also: a native question and an approval on each surface, as Q4 decides; Archive, Confirm done and hide work; one deliberately closed window reads Unsure, not Delivered; zero board restarts; at 1280×800 the first screen shows every question at five waiting. How the PM runs these cells before and through the release is E6a.

### E6a. How the PM tests this release (owner, 2026-11-24: "Add it to the plan")

**The pass bar.** A cell passes only when a reply sent from the board reaches the agent and the agent goes on with it. A card that only explains why the reply could not go in is a fail.

**The matrix: 24 cells, on two install shapes.**
- **Six surfaces:** the Claude Code CLI, the Claude desktop app, the Codex CLI, the Codex app, the Antigravity app and `agy`. DeepSeek Harness's Web surface stays a regression row outside the 24 cells; its terminal joins in 0.26.1. In every run the three app surfaces' (c) cells go first: the Codex app, the Antigravity app and `agy`, the Claude desktop app.
- **Four checks per surface:**
  - (a) the board opens;
  - (b) a question shows as one card;
  - (c) a reply from the board goes in, and the agent goes on with it;
  - (c2) a message to the stopped session with no question starts a turn (recorded on every surface; a gate line only on door surfaces, section 2);
  - (d) the status is right and timely: sent, delivered, answered, or "unsure" once its time budget is past.
  Hide, done and undo are checked in the same run.
- **Two install shapes:** one set up by `setup`, and one wired by the Claude Code plugin's connector. Every cell runs on both.
- **Each cell's record:** the date, the version or commit, the install shape, the result and the evidence. Screenshots stay out of the repository.

**Four layers.**
1. **Every pull request (CI).** Each must-ship line names a test that fails without the work. It runs on both install shapes, with stand-in agents and no model calls.
2. **The day a route merges (PM).** The PM runs that surface's cells live: CLIs in a throwaway test home, desktop apps by computer use. Sign-ins, keys, consent screens, hook approvals and tool-run approvals stay with the owner.
3. **Weekly (scheduled).** The matrix runner runs the CLI cells and posts the results on #209. A failed cell becomes an issue that day.
4. **Before release.**
   - All 24 cells run on the release build, on both install shapes, including the upgrade from 0.25.1.
   - Then the owner runs a sitting of one to two hours on his own install. It is the only proof on a real install.

**Schedule.**
- **Week 1:** the 24 cells run on the current version as the baseline. An owner app session covers spikes S1–S3.
- **Weeks 2–4:** a surface's cells run again on the day its route merges. The CLI cells all run once a week.
- **Week 5:** the full matrix runs on the release build, then the owner's sitting.

**A failed cell.** It becomes an issue with steps on synthetic data, a milestone and a Ready check. The PM closes it only after running the cell again live, on a build with the fix, and not on the pull request's word.

**Tool first: the matrix runner (N14).** A new issue for week 1, for any agent. The script:
- builds a throwaway test home for each install shape;
- runs, for each CLI, the journey "the agent asks, the board replies, the agent receives";
- prints the table.

The desktop-app cells follow a written checklist, driven by computer use.

**Who does what.**
- The lanes write the code, and someone other than the author reviews it.
- The PM tests, sorts the failures and keeps the release gate.
- The owner signs in, gives approvals, types the npm OTP and runs the final sitting.

**Limits.**
- In 0.26.1: if the PM cannot run DeepSeek Harness's terminal surface live, its cells move into the owner's sitting.
- Live CLI runs use model quota. When a vendor's weekly quota is low, the weekly run moves to after its reset.

### E7. Files to change

Generated files (`hooks/board-script*.ts`, `hooks/released.ts`, `tests/fixtures/released.ts`) are rebuilt, never edited.

- L1: `scripts/legacy-connect.ts`, `hooks/connect-pure.ts`, `scripts/connect-transaction.ts`.
- L2, L3: `hooks/digest.ts`, `hooks/register.tsx`, `hooks/inbox.ts`, `scripts/question-files.ts`, `hooks/runs.ts`, `hooks/blocks.ts`.
- L4, L5: `scripts/codex-receiver.mjs`, `scripts/session-liveness.ts`, `hooks/session-liveness.ts`, `scripts/hook-delivery.ts`, `hooks/hook-safety.ts`, `hooks/receivers/codex-app.ts`, `scripts/codex-app-receiver.ts`.
- L6: `hooks/antigravity-sidecar.ts`, `hooks/receivers/hook-mailbox-antigravity.ts`, `scripts/board-messaging.ts` (also L9).
- L7: `hooks/receiver.ts`, `hooks/receiver-record.ts`, a new `hooks/receivers/claude-desktop.ts` if S1 needs it. L8 (moved to 0.26.1, owner 2026-11-27; not in 0.26.0): `hooks/receivers/deepseek.ts`, `hooks/portable-agents.ts`, `hooks/local-agents.ts`.
- L9, L10: `hooks/messaging.ts`, `hooks/delivery-states.ts`, `hooks/receiver-routes.ts`, `scripts/board-serve.ts`, `scripts/message-store-claim.ts`; `hooks/view.ts`, `scripts/board-cli.ts` (terminal board). L11: `hooks/serve.ts`, `hooks/grouping.ts`.
- All: the three string tables (`hooks/i18n.ts`, `hooks/strings-en.ts`, `hooks/strings-zh-cn.ts`); `docs/MESSAGING.md`, `docs/SETUP.md`, `docs/GUIDE.md`, the READMEs, `SECURITY.md`, `docs/validation/PARITY-CHECKLIST.md`, `docs/validation/USER-SIM.md`. `docs/dev/product-principles.md` only by the owner's hand (Q1).

---

## F. Extensions (secondary)

- F1, the notice opens its card, fires with the page closed, and shows when it fired (#1014): ships if ready.
- F2, the row says why it is silent, from H1's last-run time: ships if ready, with L10.
- F3, a waiting card shows its last three finished steps, in the opened item only: step 2 of the page.
- F4, the row says how the session is set to ask: 0.27.0, with approvals.
- F5, a Codex session started from the board, which the board owns: dropped (owner, 2026-11-27). The board never hosts or starts sessions.

---

## G. Owner questions (five)

**Answered.** All five as recommended (owner, 2026-11-24, 「全按照建議」; #209 comment 7152245492). Later decisions: the about-3 s bar (section 2, 2026-11-26); #1652's start at the next receiver tick (#1652, 2026-11-26); #1407's rule holds from the next board start (#1407, 7167038254); the review of Antigravity Carbon's proposal, all as recommended (owner, 2026-11-26, 「全照建議」): the no-question row of section 2, L10's send control and status items, #1823's timing run in week 2, Redesign 2 in force, and #1612 at 10 s with #1890 to follow. Then "Accept C" for the scope (owner, 2026-11-27; What changed): it sets Q1's DeepSeek part and answers Q3's hosting option.

1. **Frozen hosts.** Freeze Cursor IDE and `cursor-agent`, OpenCode, Grok Build, Hermes, OpenClaw and Muse Code in 0.26.0, plus DeepSeek's desktop surface and Cordis CLI until S4 runs in 0.26.1 (owner, 2026-11-27), with principle 4 reading "every supported agent" for this release? **Recommend yes:** nothing is removed and the weekly row keeps watching them. If no: about a week per host (Cursor: K2; OpenCode: #1795).
2. **#1407, the store version.** A new store version that older readers refuse, or the rule "nothing handed out before a board start is handed out after it"? **Recommend the rule.** The way back is a typed install of 0.25.1, which must still read the store, and a second install in the same home writes `version: 2` from its own hooks (#1407). Cost: a message handed out before a board restart and never acknowledged reads Unsure after it, text kept, instead of going out again. A new version would need a step that converts the store down, which 0.26.0 lacks.
3. **A route that fails** (most likely the Codex app, if S3 finds no sign that the person typed). Ship 0.26.0 with that surface as a named FAIL (5 steps, as Copy today)? **Answered 2026-11-27 (owner, C):** yes; the board never hosts or starts sessions, F5 is dropped, and a surface whose route fails ships as a named FAIL and goes to the next re-plan. And where H passes, accept that the app shows the turn as running while it waits, at most 10 minutes, only while a visible page drew the card? **Recommend:** accept H's cost. For a failed surface, decide from its note on day 5; if nothing better is shown by day 10, ship with the named FAIL and take the surface to the next re-plan.
4. **Native prompts and approvals.** Is "every function" met by questions asked in the reply text, plus Archive, Confirm done and hide, with the host's own question tool and Codex approvals (#1318, #1319) in 0.27.0? **Recommend yes.** Claude Code approvals (#1678) already work and stay a regression row. Cost: Claude Code's question tool is mirrored, not answered (`hooks/register.tsx:4761-4773`); its card says "answer in its window". If no: about two weeks more, with #1318's safeguards in whole.
5. **The date lever.** If on day 20 a no-hook must-ship item has not merged: ship 0.26.0 without it and finish it in 0.26.1 (no hook change, as R7 allows), or hold 0.26.0? **Recommend 0.26.1 for E5's items 3 and 4 only** (#1823, #1836, P6 and P7; since 2026-11-26, #1823's timing run is not cut and #1836 has merged, E5). Hold for L9 and L10: a reply that goes in with a wrong status fails the owner's word.

**Back to #209, not asked here:** the cloud-bot bridge before the phone, and standing allow rules ("after 1.0" or "never"). Nothing in 0.26.0 depends on either.

---

## Unchecked

- I ran nothing and did not inspect the owner's install. "Today" cells come from the sitting record, the diagnosis and code at `8bbe938f`.
- Why the owner's Antigravity card had no Queue; whether the Codex daemon receiver ran on his install (C0).
- Whether any host signals typed input during a hook's wait, and how long Codex and Antigravity let a hook wait (S3).
- Whether the Claude plugin's receiver runs in the Code tab; the inbox pipe's format (S1). Whether `agy` has a continue command that is not a second writer (S2).
- Which line of #1396's wake changes a hook; whether #319 and DeepSeek's terminal (0.26.1) change compared text.
- #992 (under Q2's rule), #1622, #1467: read from titles only.
- The lane-day total (Size, E4) is a judgment per line, not a count.
- T3 Code's search was not read (P5 says it is read first).

---

## Appendix. Review findings → applied or not, and why

All 25 must-fix findings were checked; 24 are applied and 1 in part. None is rejected.

| Finding | Result | Why, and what was checked |
|---|---|---|
| Opus 1: C1 half true | Applied: C1 per host; C0 | `hooks/connect-pure.ts:651-693` (reporters), `:795-815` (worker); `scripts/codex-local.ts:1674-1677`; `scripts/board-serve.ts:1365-1372` |
| Opus 2: c passes with nothing delivered | Applied: section 2 | Principle 3; decision 1 |
| Opus 3: Codex app "3 after the wait" | Applied: 5 steps, a FAIL; wait named, 10 min; Q3 | the PM's T3 Code reading: `codex://` focuses, carries no text |
| Opus 4: H can hand one answer in twice | Applied: B1 rule, B3 items 4 and 5, the cap | `send-spikes.md:144-146`, `:155-156` |
| Opus 5: S1 to S3 need the owner's apps | Applied: the owner's app session; day 5 goes to the owner | The sitting record: the owner handles sign-ins and approvals |
| Opus 6: S2 routes around consent | Applied: S2 reads no port, token or sign-in | `docs/MESSAGING.md:183-189` |
| Opus 7: five hosts frozen, one asked | Applied: Q1 names all six | Product principles, first paragraph |
| Opus 8: cut order reverses decision 2 | Applied: E5 | Brief and decision 2 |
| Opus 9: no Done-when or test per line | Applied: E3, D; #232 in L10; L3's live note in week 2 | #232's `knownFailure` acceptance |
| Opus 10: Antigravity `waiting` fault has no home | Applied: N2 in L2 | Sitting record: "Not opened" |
| Opus 11: the size | Applied: 51 counted (55 after the PM's additions); pace quoted; checkpoints | Diagnosis E2.1 |
| Opus 12: the owner's newest word | Applied: section 1 | Owner's decisions, 7149125740 |
| Sol 1: release split | Applied: the owner chose 0.26.0; hook status per line, not per receiver | E3's last column |
| Sol 2: C1 false; #1831, #1832 causes | Applied: as Opus 1; C1 no longer named as their cause | `hooks/hook-safety.ts:290-292`; `scripts/hook-delivery.ts:185-220` |
| Sol 3: a fallback can pass | Applied: section 2; `agy` off the cut list | the PM's T3 Code reading; B1 |
| Sol 4: no full rule against a second delivery | Applied: B3 and its cases; all four limits named | #319's body; `hooks/hook-safety.ts:211-212`, `:290-292` |
| Sol 5: duplicate send after a lost response | Applied: B4 Sending; B3 item 1 | `hooks/serve.ts:1877-1879`; `hooks/messaging.ts:353-357` |
| Sol 6: "Answered" without evidence | Applied: B4 ties each state; two kinds of Answered; per-route budgets | `hooks/receivers/hook-mailbox-antigravity.ts:6-9`; `docs/MESSAGING.md:323` |
| Sol 7: DeepSeek's terminal needs code | Applied: L8 (moved to 0.26.1, owner 2026-11-27) | `hooks/receivers/deepseek.ts:20-35` |
| Sol 8: native prompts and approvals | **In part.** Applied: sitting rows per surface; the deferral is put to the owner (Q4). Not applied: native question answering as must-ship now | 7149125740 names four points; more needs his word. `hooks/register.tsx:4761` mirrors, does not answer |
| Sol 9: #1638, #1751, #1457 | Applied: L9, L6, L8 (L8 moved to 0.26.1, owner 2026-11-27) | Their bodies: message loss; a held "now" route; case 3 rejects a queued message |
| Sol 10: #1407 needs an owner choice | Applied: Q2 | #1407: "owner decision before code" |
| Sol 11: #961 is not the liveness check | Applied: #961 to 0.27.0; K-live | #961's body is about MCP leases; #1652 has its own check |
| Sol 12: the gate is incomplete | Applied: E6; "arrives by itself" removed | `docs/RELEASING.md` gate 1 to 5, step 5; `plan-0.25.2.md:112` |
| Sol 13: no testable contract per line | Applied: E3, D; undo's refusal (P7); late receipts (L0); kept drafts (#782); native prompts (E6.11) | — |

**Notes also taken:** a retry keeps its id; Antigravity's ACK; Unsure after a late kill; citations fixed; #1609, #1751 in; #1696 stays Backlog; PR #1612 as new work; #269 edited; P2 per the owner; T3 read before P5; S1 and principle 5; option G; the `/hooks` approval; shapes named; #1833 narrowed; sitting faults filed; dated baselines; Cursor's watch row; `USER-SIM.md`'s path.

# Plan for 0.24.4

The owner chose this plan on 2026-11-11, after a Fable 5.2 review of the whole project and two outside reviews of the first draft. The issues live in milestone 13. The roadmap is #209.

**Theme:** one command to install. From 0.24.4 on, the board keeps itself up to date. The Codex sessions it can see are listed. An approval a session is waiting on can be answered from the board, and the board says plainly how each answer reaches each agent.

**Size:** about 20 issues and 5 new ones, plus the delivery work. The owner's answer on size, 2026-11-11: 「全部保留，晚一週」. Nothing moves out, and 0.24.4 ships about a week later than first planned. If it still slips, cut in this order and no other:
1. The scenario-b receivers (a message to an agent that is busy): Grok first, then Hermes, then Cursor turn-end.
2. Never cut: D1, D3 (when F10 passes), OpenCode, the Codex record, the gate.

## The bar, and the step ceilings

The owner: 「希望能達到百分之九十自動 跨版本升級也能無痛…讓使用者覺得簡單 且立即能看到他們的session 再版子上面」. The bar is counted in person steps, not in typed commands. A step is learning there is something to do, starting it, answering a question, running a trust command, restarting a host, or opening the board again to check. The totals are frozen at the 2026-11-10 walk, and a journey counts only when a real session's row shows on the board.

| Journey | Today | 0.24.4 ceiling |
|---|---|---|
| Upgrade from 0.24.4 to a later version, nothing to ask | 5 of 11 | 0: the person opens the board as usual; one line says it updated |
| The same, something needs asking | 5 to 7 | 1: one confirm on the page, plus a restart only for a host whose loaded code changed |
| Upgrade to 0.24.4 from 0.24.3 | 5 of 11 (10 of 17 on Linux) | 3: learn of it, one command, one answer |
| First install, Windows, Codex only | 7 | 3: one command, one answer, restart Codex |
| First install, Linux, four agents | 8 | 6: one command, one answer, a new session in each agent |

First install does not reach 90% in 0.24.4: every host loads its hooks when a session starts, and the tool cannot remove that step. The owner accepted this: 「接受，寫進計畫」. The 0.24.3 script has no update check, so that one upgrade costs one command; "0 steps" holds only from 0.24.4 on.

## Milestones

### M0. The ledger, the journeys and the checks
- **Work:** the user-simulation record gains the step ledger and two upgrade journeys, J11a (from the last release) and J11b (from this release to a locally built next one), each for a terminal person and an app person (#851, #1297). It fails when a count rises. Checks F1 to F13 (below) run before the milestone each feeds, with a dated note each.
- **Done when:** the journey reports today's counts by kind, and the notes exist. A check that fails changes its milestone's "Done when" before work starts.
- **Test:** the journey, in plain Node.

### M1. OpenClaw and DeepSeek Harness report
- **Work:** from F1, F2 and F7. OpenClaw's model called neither plan tool, so only a placeholder row showed. If F1 confirms it, steps come from what the host emits, not from asking the model. DeepSeek: setup wrote its files and `dsh` never ran.
- **Done when:** for each host, an interactive session given an ordinary task shows steps and one `[?]` question under Needs you, or the row says plainly that it cannot. Delivery to these two is judged by D2's table.
- **Test:** a plugin-level test that a plan-tool call and the lifecycle path both reach the writer; live records with the prompt quoted.

### M2. An upgrade never stops, and nothing is guessed
- **Work:** a generated file the person edited is never overwritten (text a host only reads gets the new file beside it; code a host loads keeps the old files and says so); no question either way. Files a release stops writing are removed when their bytes are still ours, kept and named otherwise. An old install record keeps what it recorded. `--json` through an older script fails with a notice (#1304). Gemini CLI is retired: setup no longer offers it, an upgrade or remove takes away its files whose bytes are ours, and it never touches Antigravity's files.
- **Done when:** the Linux U3 failure passes with the person's line still on disk; a home with Gemini and Antigravity both installed ends with Antigravity unchanged byte for byte.
- **Test:** `host-upgrade` cases for an edited skill, an edited hook runner, a dropped file, records with and without `createdDirs`; the Gemini and Antigravity fixture; `npm-package` with a 0.24.2 script.

### M3. The update entry, and when it asks
- **Work:** one entry, `setup --update`. It asks when a hook's command changed or a file a host loads as code changed; when the host does not confirm, read back now, that it trusts the board's hooks (`scripts/codex-approval.ts:5-11, 34`); or when the release marks a new kind of network use or file reading. Otherwise it updates and prints one line. What the person turned off stays off. The question shows the exact hook commands and needs a typed `y` or a confirm on the page. A failed update leaves the old files working. New issue.
- **Done when:** J11b counts 0 steps with nothing to ask and 1 with something; a revoked approval is still revoked afterwards.
- **Test:** J11b; a case for each ask condition, a removed hook group, revoked trust, an update killed halfway; a dated manual row with a real Codex.
- **Review:** full security review. The owner writes the rule "a patch release never adds, removes or rewords a hook".

### M4. The board learns of a new version and starts the update
- **Work:** one request a day to the npm registry for the latest version number, on by default, with an off switch, never from a hook, never holding up `--json` or `--status` (2 s limit, background). When a person opens the board and a newer version is known, the installed script starts `setup --update` of that exact version through `npx`, in the background. The owner: 「可以，自己升級」. An agent's `--json`, `--status`, `--report` and every hook never start an update. Where there is no `npx` or the sandbox blocks the request (F4), the board shows the line and the command. `SECURITY.md` line 63 changes to say what runs, when, and how to turn it off. New issue.
- **Done when:** with a locally built higher version and a stub registry, opening the board updates the home with no command typed; with the setting off, no request leaves the computer.
- **Test:** stub registry cases (one request a day across concurrent commands, off means none, a dead endpoint costs under 2 s); a live row from Codex CLI and the Codex app.

### M5. First install: one command, one answer
- **Work:** the bare `npx @wenyuchiou/agent-board` is the Quick start's only command: preview, one question, set up the agents found, approve Codex and Hermes hooks, install the Claude Code plugin where present, open the board. No Codex gives no trust step (#1272); a one-agent repair lists only its steps (#1278); `--agent claude` points to the plugin (#1289). The last lines say per agent whether a new session is needed. Also #868, #865.
- **Done when:** walked on Windows in a real terminal (F5) and on Linux in a pseudo-terminal, ending in a real session's row, within the ceilings above.
- **Test:** the pseudo-terminal journey in CI; a dated manual row on Windows; `setup-guidance` cases.

### M6. The Codex sessions the board can see are listed
- **Work:** new bounded code lists Codex's own session records, newest first: folder, start time, id and last-written time, never the conversation. Only a record written in the last 24 hours, at most ten; helper threads and program-started runs are left out. The list is compared with the board at every open, so a session with no row of its own shows even when others report. These rows sit in their own folded group, "Seen in Codex's records, not connected", and are not counted under Working or Needs you. The row says the folder and "last active N hours ago", and says what makes it connect as F3 finds. New issue.
- **Done when:** with one session reporting and two only in the records, the board shows one normal row and two in the folded group; a record with conversation text proves none reaches the board or `--json`.
- **Test:** fixtures for an empty board, the mixed case, a helper thread, a `codex exec` record, an old session written to an hour ago, a record over 24 hours old.

### M7. What the board shows can be believed
- **Work:** one count for the page, the terminal board, `--status` and `--json` (#1296). A row with no event for a set time and no live process says "unsure" with its age. A closed agent window takes its card with it (#1092, pull request #1288). The four gaps from the outside read of #1264 (#1276). The question-finding design is decided here, measured first: fixed shape set from synthetic replies in three languages (#1287, #1290), the miss and false-question rates of today's rules, then the owner picks.
- **Done when:** the four surfaces agree on every count in the user-simulation run; no row stays "working" after its turn ended; the rates and the choice are on the issue.
- **Test:** one file fed to the four surfaces; a stale-row case in `tests/e2e/l4-time`; the shape set as a table test.

### M8. Proof, then stable
Records on the tagged head. The gate:
1. CI green on Ubuntu and Windows, as RELEASING.md line 17 asks.
2. The delivery table: one row per agent, surface and scenario (a idle, b mid-turn, c stopped on a question), each marked `now`, `later` (turn end, next turn or reopen), `cannot` (named) or `not run`. Every agent in the README support table has a surface with a and c at `now` or `later`, or its card and the README say "cannot receive yet". No card wording disagrees with its record. The release notes print the counts. #557 is one row.
3. The usersim record with the ledger, at the ceilings above, each journey ending in a real session's row.
4. One live row: the daily check from inside Codex CLI and the Codex app (F4).
5. Must-ship closed, and every lane-reviewed pull request read from outside. The three IDE rows run if a person can type into them; otherwise they are named as not run.

## Delivery: an answer pressed on the board reaches the agent (lane E)

A next-turn mailbox cannot answer an agent that sits idle on a question. Only Claude Code CLI, DeepSeek and, new in this version, OpenCode wake an idle session; Codex does too if F6 passes. The rest receive at their next turn, and the card says so. The wake for those hosts (`board_wait`, #685) is 0.24.5. The owner: 「老實寫下一輪收到」.

**Order in lane E.** D1, then **D3 approvals first**, then answers to a question with choices, then free messages to a busy agent last. The owner: 「主要是他在问你同不同意的那个部分，我们可以直接在板上面做送出吧」 and, asked which comes first, 「審批第一，訊息最後」.

### D1. One Send button that says what will happen
- **Work:** every card has Send and one line chosen by the board from the receiver's record: goes in now, goes in when its current step ends, goes in at its next turn (it will not wake it), goes in when this chat is opened again, reopens the session and sends, or cannot receive yet (copy). Each receiver record gains `routes: { idle, working, ended }`; the page's two hard-coded agent names (`hooks/serve.ts:1607-1612`) go. The matrix script prints the same record. The LAN page shows no Send.
- **Done when:** every card shows Send and one of the lines; `isAtOnce` and `isOpenOnly` are gone.
- **Test:** a table test of every receiver record against idle, working and ended, in three languages.

### D3. Approvals on the board
The owner: 「0.24.4 就上，有條件」. The limits, exactly:
- **Allow once** and **Deny** for Codex, OpenCode and Claude Code. Claude Code joins through its `PermissionRequest` hook (F13: its hook documentation says the hook can wait and answer allow or deny, and adds no standing rule unless the hook asks for one; one live run must still show what the terminal shows while the hook waits). Cursor and Grok can only be denied, so their card offers Deny only. Hermes has no button (its approval hooks only observe). Antigravity documents no way to answer its prompt, so its card shows the request and no button; a live test is 0.24.5. Many Antigravity users run it in turbo mode (it always goes ahead and never asks), where there is nothing to approve: the board only shows its progress and hands it messages, at its next turn. The owner, 2026-11-11: 「它其实可以开一个 turbo 模式，就是一直都过不会问…只要发讯息，它也只是一个传送而已」.
- No button where no hook runs: Claude Code in `bypassPermissions` or `dontAsk` mode, or with every hook turned off. A Claude Code session run with `-p` denies a call that no hook decides, so the 30 s fallback to the host's own prompt holds for interactive sessions only.
- Approvals take their own route, a hook asking the local page, never the message path. This changes a written rule: `docs/MESSAGING.md` (lines 8, 235, 280, 431, 602) says a message never approves a tool. `MESSAGING.md` and `docs/dev/product-principles.md` change in the same pull request, by the owner's hand approval.
- The local 127.0.0.1 page only; the LAN page shows the request and no button.
- Bound to session, turn and a hash of the exact command, which is shown in full.
- The hook waits at most 30 s, then returns no decision and the host's own prompt appears as today.
- Never "always". Every approval is journaled with the command.
- Ships only if F10 shows a command inside a gated Codex session cannot read the address file and post to the page.
- `SECURITY.md` states the hole that stays: any program running as the person can press it. This is the owner's own approval to give.
- This takes the approval part of #1119 into 0.24.4. The token redesign stays in 0.24.5.
- **Test:** a stand-in hook that waits: allow-once reaches only the bound request, 30 s falls back, the LAN is refused. New issue.

### D2. Receivers, one pull request per host
In this order: OpenCode (a new receiver on the DeepSeek pattern; wakes an idle session, hands over at `session.idle`), Codex turn end (a `Stop` hand-over, and the wake if F6 passes), Cursor (enroll on any hook event, hand over at `stop`), Hermes, Grok (only if F8 passes). Before the first, a small pull request moves the turn-event block out of `scripts/codex-local.ts:1076-1115` into `scripts/hook-delivery.ts`. Hook changes must land in this version, not a patch.
- **Done when:** per host, the stand-in test passes and the live record reads `now` or `later` for a, b and c. Every record quotes the line the card showed under Send; a record where the card promised one thing and another happened is a FAIL.
- **Test:** stand-in agents prove the wire shape and the store's state; only a live record proves the host obeys. Records are `docs/validation/<date>-<host>-live.md`.

## The checks

Half a day each, a dated note each, before the milestone they feed.

| Check | Answers | Feeds |
|---|---|---|
| F1 | With an ordinary prompt, does an OpenClaw plan-tool call reach the board? | M1 |
| F2 | Can `dsh` be installed in a test home and run one session? (the download needs the owner's OK then) | M1 |
| F3 | Is a Codex session open before setup connected after restart and resume, under which id? Where does the app keep its threads? | M6 |
| F4 | Can the version check reach npm from inside Codex's sandbox and the Codex app? | M4, M8 |
| F5 | Does the `[Y/n]` setup work in a real Windows terminal? | M5 |
| F6 | Can the Codex daemon's `turn/start` wake an idle CLI thread? | D2 |
| F7 | Can OpenClaw's in-process plugin send into a session without a gateway credential? | M1, D2 |
| F8 | Does Grok's `UserPromptSubmit` output reach the model, and does a blocked `Stop` continue? | D2 |
| F9 | OpenCode: `promptAsync` or `prompt`, and does it wake an idle session? | D2 |
| F10 | Can a command inside a gated Codex session read the address file and post to 127.0.0.1? | D3 |
| F11 | Copilot: its hooks and session id. Notes only. | 0.24.5 |
| F12 | Windsurf: hooks or MCP only. Notes only. | 0.24.5 |
| F13 | Does Claude Code's `PermissionRequest` hook let the board's hook wait for the press and return allow or deny (and Antigravity, if it has such a hook)? Read 2026-11-11 from the hook documentation: yes for Claude Code, one live run left; no documented answer route for Antigravity. | D3 |

## Lanes and merge order

| Lane | Milestones, in turn | Main files |
|---|---|---|
| A, setup and upgrade | M2, M3, M5 | `scripts/codex-local.ts`, `scripts/setup-agent.mjs`, `bin/agent-board.mjs` |
| B, the board | M4, M6, M7 | `scripts/board-cli.ts`, `scripts/board-serve.ts`, `scripts/codex-history.ts`, `hooks/view.ts`, `hooks/digest.ts` |
| C, hosts | M1, then D2 OpenCode, Hermes and Grok hook tables | `hooks/portable-agents.ts`, `hooks/local-agents.ts`, `hooks/receivers/` |
| D, records | M0, then M8 | `docs/validation/`, tests |
| E, delivery | the extraction, D1, D3, D2 Codex and Cursor | `scripts/hook-delivery.ts`, `hooks/hook-messages.ts`, `hooks/receivers/`, `hooks/serve.ts`, `scripts/messaging-matrix.mjs` |

- Lanes A, B, C and E all rebuild the board bundle: one bundle-touching pull request merges at a time, and the next merges main and rebuilds first.
- Lane B's milestones run one after another. M3 merges before M4. The extraction merges on day one; D1 merges before M7, which also changes cards in `hooks/serve.ts`.

## What 0.24.4 must not claim

- "Upgrades itself" for the upgrade to 0.24.4, for an install with no `npx`, or for the Claude Code plugin (its own channel). "0 typed commands" without "from 0.24.4 on, when nothing needs asking".
- "90% automatic" for first install, for an app or IDE person, or for macOS (no run).
- "Your sessions are there" or "at once": the board lists Codex sessions found in Codex's records, marked not connected. No other host.
- Send, Queue or "receives" for an agent or surface with no live record on the 0.24.4 head. "Goes in now" where the record shows turn end or next turn. "Every agent receives" or "no Copy": the release notes print the delivery table's counts instead. "Approve from the board" unless D3 shipped (F10 passed). "Wakes an idle session" for a hook-mailbox host.
- "Opens a window" in any app not shown doing so on the 0.24.4 head (#865).
- "Nothing to install": Node 22 or newer and a terminal are needed once.
- "No network use": one request a day, on by default.
- "An agent cannot act as the person on the board": it can. An agent shown the page link, or that looks for it, can act as the person; `SECURITY.md` says so. The fix is 0.24.5.
- "Works with Muse Code" or "Gemini CLI". "Works in <app or IDE>" for a row not run.
- "Stable" before the five gate lines hold.

## Moved to 0.24.5

- **The token redesign:** a link that works once, a page session in no address, a separate credential for the board's own client. It must land before the rest of #1119.
- **The wake for hook-only agents,** `board_wait` (#685), for Codex (if F6 fails), Antigravity, Cursor, Grok and Hermes.
- **Copilot and one general MCP route** (setup writes the MCP entry, a `board_report` tool, `board_wait`) for Junie, Zed, Amp, Augment and Factory; Windsurf through the same route.
- **Cloud bots:** the bridge plan (#866), the trial one release later.
- **Remove polish and setup words that block nobody:** #1244, #1271, #1202, #1245, #1295, #768, #1275.
- **CI flakes** #910, #835, #998, #1135, unless one blocks a merge. The first-try figure is reported, not a gate.
- **Also:** #317, #723, #686, #852, #803, #826, the rest of #844, #1268, #1274; #318, #319, #722; #1014, #548, #1023; #1084, #1164, #1280, #1025, #922, #402; #1283, #1294, #1298; #1228 with #1251, #1137, #1159; #1041, #1066, #1057; #491, #1038, #1277.

## CI and team process

The owner: 「全部加進去」. Lane D carries the first three as issues; the fourth goes in one owner-approved pull request with the hook-freeze rule and the tiered review (#1285); the last two are the maintainer's practice.
1. Tests stop asserting wall-clock limits under 1 s on the shared runner (a fake clock or counted work), and every test file stays under 70% of its time budget; a file over it fails the pull request, not main. The sampler for the CI first-try figure is #1249.
2. Check the pull-request-versus-main matrix first: a pull request runs Node 22 Ubuntu and Node 24 Windows, main all four pairs (`docs/dev/CI.md`). Change the split only if a failed main run broke on a pair the pull request never ran.
3. A duplicate-issue check: a new issue's title is compared with open issues before it is accepted (#1257 and #1259 shared a title word for word); a lane that files a finding links the pull request it came from.
4. `RULES.md` R1 names the role: "maintainer: reviews, merges, releases, plans no other lane's work". The owner approves it by hand.
5. `scripts/team-stats.mjs` output is posted weekly on #209.
6. dot gets only work that fits one push (it cannot update an existing branch and has no `gh`).

## Scope kept from the first draft

- **In:** #1305, #1302, #1303, #1304 (upgrade); #868, #865, #1272, #1278, #1289 (first install); #1296, #1092 with pull request #1288, #1287, #1290 (status and questions); #557 (the next-turn record); #851, #1297 (the ledger); #1276 (owed from the 0.24.3 outside read); #1249; OpenClaw and DeepSeek Harness; Gemini CLI retirement. New issues to open: the update entry and ask rule (M3), the daily check and its start (M4), Codex sessions from its records (M6), the ledger and J11 (M0), and approvals on the board (D3).
- **README (#1267)** is in flight outside this plan; its pictures show only the seven agents with live records, and Muse Code leaves the support table in all three languages.
- **Process, no version:** #1285, #1257 with its pull request #1259, #1258.
- **May close, each after its check:** #884 (every skill reads `--json`; the MCP part is #723), #810 (only if a real SSH terminal can be tried), #1161 (each open item has its own issue).

# Plan for 0.25.0

Called 0.24.4 until 2026-11-11, when the owner renamed it: 「改叫 0.25.0」. It adds hooks, and a patch release, one that changes only the last number, adds none (#1285). 0.24.5 is now 0.25.1.

The owner chose this plan on 2026-11-11, after a Fable 5.2 review of the whole project and two outside reviews of the first draft. The issues live in milestone 13. The roadmap is #209.

**Theme:** one command to install. From 0.25.0 on, the board keeps itself up to date. The Codex sessions it can see are listed. An approval a session is waiting on can be answered from the board, and the board says plainly how each answer reaches each agent.

**Size:** about 20 issues and 8 new ones, plus the delivery work. The owner's answer on size, 2026-11-11: 「全部保留，晚一週」. Nothing moves out, and 0.25.0 ships about a week later than first planned; Copilot's first step (below) may add about 3 to 5 days more, if F11 passes and its hook shapes match Claude Code's. If it still slips, cut in this order and no other:
1. The scenario-b receivers (a message to an agent that is busy): Grok first, then Hermes.
2. The approval routes on the other hosts, each one whose check has not passed: DeepSeek Harness, then OpenClaw, then Grok, then Hermes. A cut route leaves "answer in its window" on its card.
3. Never cut: D1, D3 (when F10 passes), OpenCode, the Codex record, the gate, and Cursor's two receiver steps in D2 (it enrolls on any hook event, and hands over at `stop`).

A cut item that needs a hook change waits for 0.26.0, not 0.25.1, since a patch release adds no hook (line 3); when the other cut items return is not decided. Copilot's first step is not on this list: it leaves 0.25.0 only if its check, F11, fails.

**The hosts people use most.** Fable 5.2 read this plan from the person's side on 2026-11-11 (survey shares of regular agent users: Claude Code 71%, Copilot about 46%, Cursor 39%, Codex about 23%, OpenCode and Antigravity about 10% each; Windsurf among the less mentioned; none found for Grok, Hermes, OpenClaw or DeepSeek Harness). It found the hosts most people use getting the least: Copilot (the share counts all its surfaces) had no card at all, and Cursor, the third most used, was in the first group to be cut, after Grok and Hermes. Three changes, each the owner's answer to one question, 2026-11-11: Cursor is never cut (above); Copilot gets a first step in 0.25.0 if its check passes (below); the approval routes of the four small hosts are cut DeepSeek Harness first and Hermes last (above). The owner: 「我都同意」, to these three and to Fable's recommended order of the host checks (The checks, below).

## The bar, and the step ceilings

The owner: 「希望能達到百分之九十自動 跨版本升級也能無痛…讓使用者覺得簡單 且立即能看到他們的session 再版子上面」. The bar is counted in person steps, not in typed commands. A step is learning there is something to do, starting it, answering a question, running a trust command, restarting a host, or opening the board again to check. The totals are frozen at the 2026-11-10 walk, and a journey counts only when a real session's row shows on the board.

| Journey | Today | 0.25.0 ceiling |
|---|---|---|
| Upgrade from 0.25.0 to a later version, nothing to ask | 5 of 11 | 0: the person opens the board as usual; one line says it updated |
| The same, something needs asking | 5 to 7 | 1: one confirm on the page, plus a restart only for a host whose loaded code changed |
| Upgrade to 0.25.0 from 0.24.3 | 5 of 11 (10 of 17 on Linux) | 3: learn of it, one command, one answer; plus one restart for each host whose loaded hooks changed (0.25.0 changes the approval hooks, D3), counted as steps |
| First install, Windows, Codex only | 7 | 3: one command, one answer, restart Codex |
| First install, Linux, four agents | 8 | 6: one command, one answer, a new session in each agent |

First install does not reach 90% in 0.25.0: every host loads its hooks when a session starts, and the tool cannot remove that step. The owner accepted this: 「接受，寫進計畫」. The 0.24.3 script has no update check, so that one upgrade costs one command; "0 steps" holds only from 0.25.0 on.

## Milestones

### M0. The ledger, the journeys and the checks
- **Work:** the user-simulation record gains the step ledger and two upgrade journeys, J11a (from the last release) and J11b (from this release to a locally built next one). Each is walked by a CLI person and by a UI person, per agent. As #851 asks: `USER-SIM.md` names both persons (the UI person uses only desktop apps, IDEs and the board's page, and opens a terminal only where the release still requires it; the record says each place that required one); the parity record and the live run end with one summary table per person, one row per AI, counting the steps for installing, opening the board, seeing every agent, answering a question, sending to another agent and getting the reply (a copy, a window switch or a typed command is a step); the release notes list both summaries. It fails when a count rises. The record's screenshots go where #1297 decides, and `USER-SIM.md` and `scripts/pr-check.mjs` then say the same place (#1297). Checks F1 to F21 (below) run before the milestone each feeds, with a dated note each.
- **Done when:** the journey reports today's counts by kind, per person and per agent; the parity record and the live run have both summary tables, and the release notes list them; USER-SIM.md and pr-check agree on screenshots; the notes exist. A check that fails changes its milestone's "Done when" before work starts.
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
- **Work:** the bare `npx @wenyuchiou/agent-board` is the Quick start's only command: preview, one question, set up the agents found, approve Codex and Hermes hooks, install the Claude Code plugin where present, open the board. No Codex gives no trust step. A Codex that is installed but not found on `PATH` gets the whole trust command to copy, with a placeholder for its path (`npx @wenyuchiou/agent-board setup --codex-trust --codex-bin <full path to codex>`), in setup's next steps and the doctor, in all three languages (#1272); a one-agent repair lists only its steps (#1278); `--agent claude` points to the plugin (#1289). The last lines say per agent whether a new session is needed. Also #868, #865.
- **Done when:** walked on Windows in a real terminal (F5) and on Linux in a pseudo-terminal, ending in a real session's row, within the ceilings above.
- **Test:** the pseudo-terminal journey in CI; a dated manual row on Windows; `setup-guidance` cases.

### M6. The Codex sessions the board can see are listed
- **Work:** new bounded code lists Codex's own session records, newest first: folder, start time, id and last-written time, never the conversation. Only a record written in the last 24 hours, at most ten; helper threads and program-started runs are left out. The list is compared with the board at every open, so a session with no row of its own shows even when others report. These rows sit in their own folded group, "Seen in Codex's records, not connected", and are not counted under Working or Needs you. The row says the folder and "last active N hours ago", and says what makes it connect as F3 finds. New issue.
- **Done when:** with one session reporting and two only in the records, the board shows one normal row and two in the folded group; a record with conversation text proves none reaches the board or `--json`.
- **Test:** fixtures for an empty board, the mixed case, a helper thread, a `codex exec` record, an old session written to an hour ago, a record over 24 hours old.

### M7. What the board shows can be believed
- **Work:** one count for the page, the terminal board, `--status` and `--json` (#1296). A row with no event for a set time and no live process says "unsure" with its age. A closed agent window takes its card with it (#1092, pull request #1288). The four gaps from the outside read of #1264 (#1276). The question-finding design is decided (owner, 2026-11-11: 「照 Fable 建議」, after a Fable 5.2 diagnosis of the 11 review rounds of pull request #1342): an approval comes only from the host's permission event, an answer from the host's question tool or a `[?]` step, and the reply text only as a fallback for a turn that ended with steps left and nothing asked. A missed question costs little there (the row shows "Stopped, not finished") and a false card costs a lot, so a change that widens the reply parser is taken only when the fixed shape set (#1287) shows no new false question. #1290 is folded into the six states below.
- **Six row states.** Today "waiting on your reply" covers both a question and a turn that simply stopped, so a person cannot tell which one needs a decision. Each row now takes one of six states, read from the host's events and the agent's own steps, and each state has the one action the board offers. New issue. The owner, 2026-11-11: 「我们要想一下这几个状态」, then 「寫進 0.25.0」.

  | State | When | Action on the board |
  |---|---|---|
  | Working | a turn started and has not ended | none |
  | Waits for your approval | the host is asking to run a tool | Allow once or Deny, where D3 allows it |
  | Waits for your answer | the turn ended on a question, or a `[?]` step | the choices, or a reply, with D1's line |
  | Stopped, not finished | the turn ended, steps are left, and nothing was asked | Continue, sent with D1's line |
  | Done, to check | the turn ended and every step is done or cancelled | Seen, which moves it to Done recently |
  | Conversation ended | the host's session-end event, or no event for a set time and no live process | take over, or reopen where the host can resume |

  The first four after Working sit under Needs you in amber; Done, to check sits there too, in green, until Seen is pressed, and is counted apart from the waiting ones. The page, the terminal board, `--status` and `--json` use the same six states.
- **Rules from the outside read of this table** (Fable 5.2, 2026-11-11: 4 critical, 8 high and 4 medium holes, its report kept with the project review notes). The press rules are D3's: each press carries the item's id, turn and state (OpenCode, which gives no turn, only if F15 passes), and an agent cannot press. Here:
  - A seventh row, **Turn ended (cannot tell if finished)**: grey, outside Needs you, no button. It is used when the agent keeps no step list, when the only open step is the hook's own placeholder, or when the plan was not updated in the turn that just ended. "Stopped, not finished" needs a plan update inside that turn.
  - A turn the person stopped (Codex Interrupt, Esc or Ctrl+C in Claude Code) shows "You stopped it", outside Needs you.
  - A `[!]` step shows as Blocked, with its note, among the answers. A row whose only open steps are `[>]` or wait for someone else shows "Waiting on something else", outside Needs you. Hand-kept tasks are outside the six.
  - The order when two apply: approval, answer, stopped, done to check, ended.
  - A pending approval or question leaves Needs you, and its buttons go, as soon as its session is confirmed ended (the host's session-end event, or the process check) or the host reports it answered elsewhere. The row keeps it in its history as "asked, not answered here" (#1092, the close-during-approval case).
  - The closing words of a finished turn ("Want me to add tests too?") do not hold it amber: with every step done it is Done, to check, with the question as a line. A turn whose reply text the board never sees (Gemini, Muse, OpenClaw, DeepSeek) cannot show Waits for your answer from its text, and never offers Continue.
  - Continue only where the host wakes an idle session (Claude Code CLI, DeepSeek, OpenCode; Codex if F6 passes). Elsewhere the card says "open its window to continue", with the take-over link. A queued Continue is dropped when the person's own prompt reaches the agent first.
  - Counts: `waiting` stays approvals plus answers; `stopped` and `toCheck` are new numbers beside it. Reminders and notifications fire for approvals and answers only.
  - Seen is kept by session and turn, so a late event for the same turn does not bring the row back. An unseen Done, to check is never archived on its own; it folds into Done recently after 3 days.
  - "No event for a set time" is 30 minutes, the board's existing "not heard from". The process check records a process id and its start time at session start, for terminal hosts only; without both, a row can be "unsure", never "ended". App and IDE hosts stay "unsure".
  - Before the table test is written, one live record per host for the event orders not proven from code: Hermes (an end after each model call), Antigravity (Stop ends a loop, not a turn), Codex (a plan event after Stop), Muse (whether it ever shows Working).
  - Defaults the owner may still change: whether Stopped counts in the Needs-you number (not counted), Continue on hosts that cannot be woken (absent), how long an unseen Done, to check stays (3 days), a courtesy question after finished work (Done, to check).
- **Known limits, said as they are.** "Stopped, not finished" and "done, to check" show only for a host whose turn-end event order a live record has shown (the four above still need one), and only for a turn in which the agent updated its step list. Any other turn that ended with no approval or answer pending reads "Turn ended (cannot tell if finished)"; a pending approval or answer keeps its own state, by the order above. Antigravity and Hermes send no session-end event (Hermes fires its end after every turn), and a window closed by force or a crash sends none from any host: for those, "conversation ended" rests on the process check, and until then the row says "unsure" with its age. An agent that keeps no step list gives the board no way to tell "stopped" from "done", and its row says so.
- **Done when:** the four surfaces agree on every count in the user-simulation run; no row stays "working" after its turn ended; the rates and the choice are on the issue. On each host with a live record, a turn that asks, a turn that stops with steps left, a turn that finishes and a closed window each show their state; Seen moves a row to Done recently, and it stays there until a new turn starts.
- **Test:** one file fed to the four surfaces; a stale-row case in `tests/e2e/l4-time`; the shape set as a table test; a table test from each host's events and steps to the six states.

### M8. Proof, then stable
Records on the tagged head. The gate:
1. `docs/RELEASING.md`'s release gate, checked on the exact tagged commit: CI green on Ubuntu and Windows; the vendor parity record `docs/validation/<date>-parity-0.25.0.md`, every FAIL in it naming an open issue outside the must-ship set; the L1 to L3 user-journey tests and the upgrade journeys in `tests/host-upgrade.test.mjs` passing on that commit.
2. The delivery table: one row per agent, surface and scenario (a idle, b mid-turn, c stopped on a question), each marked `now`, `later` (turn end, next turn or reopen) or `cannot` (named); `not run` only for a surface outside line 6's list. Every agent in the README support table has a surface with a and c at `now` or `later`, or its card and the README say "cannot receive yet". No card wording disagrees with its record. The release notes print the counts. #557 is one row.
3. The usersim record with the ledger, at the ceilings above with each needed host restart counted as a step, each journey ending in a real session's row.
4. One live row: the daily check from inside Codex CLI and the Codex app (F4).
5. Must-ship closed, and every lane-reviewed pull request read from outside.
6. These ten AIs are tested live on the 0.25.0 head (the retired or deferred ones, Gemini CLI, Muse Code and Windsurf, are not in it): Claude Code, Codex (CLI and app), OpenCode, Antigravity, Cursor, GitHub Copilot CLI (if F11 passed; if it failed, its record says so and Copilot is not in 0.25.0), Grok Build, Hermes Agent, OpenClaw and DeepSeek Harness. Each has a dated record for the rows that apply to it: its row states (M7), its approval route or its "answer in its window" card (D3, other hosts), and delivery a and c (D2). A row a person must type into (the IDE rows) is run by the owner with the PM. `not run` is not accepted for these AIs. The owner, 2026-11-11: 「你剛剛提到的每個AI都要確實測試」.

## Delivery: an answer pressed on the board reaches the agent (lane E)

A next-turn mailbox cannot answer an agent that sits idle on a question. Only Claude Code CLI, DeepSeek and, new in this version, OpenCode wake an idle session; Codex does too if F6 passes. The rest that have a receiving route receive at their next turn, and the card says so; Copilot CLI has none in 0.25.0. The wake for those hosts (`board_wait`, #685) is 0.25.1. The owner: 「老實寫下一輪收到」.

**Order in lane E.** D1, then **D3 approvals first**, then answers to a question with choices, then free messages to a busy agent last. The owner: 「主要是他在问你同不同意的那个部分，我们可以直接在板上面做送出吧」 and, asked which comes first, 「審批第一，訊息最後」.

### D1. One Send button that says what will happen
- **Work:** every card shows one line chosen by the board from the receiver's record: goes in now, goes in when its current step ends, goes in at its next turn (it will not wake it), goes in when this chat is opened again, reopens the session and sends, or cannot receive yet. Send shows only with a line whose route a live record on the 0.25.0 head has shown; "cannot receive yet", and any route without such a record, shows Copy instead and no Send. Each receiver record gains `routes: { idle, working, ended }`; the page's two hard-coded agent names (`hooks/serve.ts:1607-1612`) go. The matrix script prints the same record. The LAN page shows no Send.
- **Done when:** every card shows one of the lines, with Send only where the route is recorded and Copy otherwise; `isAtOnce` and `isOpenOnly` are gone.
- **Test:** a table test of every receiver record against idle, working and ended, in three languages, including a route with no record showing Copy and no Send.

### D3. Approvals on the board
The owner: 「0.25.0 就上，有條件」. The limits, exactly:
- **Allow once** and **Deny** for Codex and Claude Code, and for OpenCode only if F15 passes (below); otherwise OpenCode shows the request and "answer in its window", with no button. Claude Code joins through its `PermissionRequest` hook (F13: its hook documentation says the hook can wait and answer allow or deny, and adds no standing rule unless the hook asks for one; one live run must still show what the terminal shows while the hook waits). If F11 passes, GitHub Copilot CLI shows a pending request and "answer in its window", with no button (its first step, below). Antigravity, Cursor, Grok, Hermes, OpenClaw and DeepSeek Harness get only what their route in "Approvals and questions on the other hosts" (below) allows, and only after that route's check has passed on a live record; until then their card shows the request and "answer in its window", with no button. Many Antigravity users run it in turbo mode (it always goes ahead and never asks), where there is nothing to approve: the board only shows its progress and hands it messages, at its next turn. The owner, 2026-11-11: 「它其实可以开一个 turbo 模式，就是一直都过不会问…只要发讯息，它也只是一个传送而已」.
- No button where no hook runs: Claude Code in `bypassPermissions` or `dontAsk` mode, or with every hook turned off. A Claude Code session run with `-p` denies a call that no hook decides, so the 30 s fallback to the host's own prompt holds for interactive sessions only.
- Approvals take their own route, a hook asking the local page, never the message path. This changes a written rule: `docs/MESSAGING.md` (lines 8, 235, 280, 431, 602) says a message never approves a tool. `MESSAGING.md` and `docs/dev/product-principles.md` change in the same pull request, by the owner's hand approval.
- The local 127.0.0.1 page only. The LAN page says "an approval is waiting" and shows neither the command nor a button.
- Each pending request is its own item, with the host's own request id; a session may have several, and a sub-agent's request shows on its parent's row. A press carries that id, the turn and the state the page drew; the server refuses it on any difference and redraws. Where the host gives no request id, the board shows the request and no button. Where it gives a request id but no turn (OpenCode's status events have no turn id), the press carries the request id and the state the page drew, and OpenCode keeps its buttons only if F15 shows on a live record that such a press answers that one request and no other; if it does not, OpenCode shows the request and no button, and its line above and the release notes say so.
- The command is shown in full after the board's `redact`. The journal keeps its hash and first words only. `scripts/codex-local.ts:638-639` and `docs/SETUP.md:326-328` promise that tool inputs and permission decisions are not kept; they change in the same pull request.
- Allow once and Deny only: never "always", never "for this session". Where the host's route takes a message with a denial (Claude Code and Codex; on the other hosts, where their check shows it), a "Deny and say why" box sends it; elsewhere Deny goes without a reason. The owner, 2026-11-11: 「照建議」.
- The hook waits only while a local page is open and has confirmed it drew the request, and at most 30 s. Otherwise it returns at once with no decision, and the host's own prompt appears as today; the one exception is a host the person has put under the board as the gate (below), where it denies instead. After that fallback the row says "asked in its window", with no button. The installed hook limit is 3 s today (`hooks/hook-safety.ts:17-24`), so this is a hook change: existing installs get it through the update entry (M3).
- An agent cannot press it: the approve route needs a secret that exists only in the open page, not in the address file, and the board's agent tools never offer Allow, Continue or Seen. The first press for a session asks the person to confirm once on the page before anything is sent. Ships on a host only if F10 shows, on that host, that a command inside the agent's session cannot approve: Codex, OpenCode and Claude Code first, and each other host's route before it gets a button.
- `SECURITY.md` states the hole that stays: a program running as the person that can drive the browser can still press it. This is the owner's own approval to give.
- This takes the approval part of #1119 into 0.25.0. The token redesign stays in 0.25.1.
- **Test:** a stand-in hook that waits: allow-once reaches only the bound request; a press with an old id, turn or state is refused; a press without the page's secret is refused; the first press in a session waits for the confirm; no open page returns at once; 30 s falls back; the LAN is refused. New issue.

### Answer or send: the controls for each kind of prompt
The owner, 2026-11-11: 「因為要讓使用者在板子上直接點選項傳送 還是訊息 那個得想想 針對AI怎麼問 決定按鈕與傳送怎麼設計吧」, and on the proposal below, 「照建議」. Every host asks differently (the 2026-11-11 survey of host documentation, not yet live: the checks below). The board does one of two things, and the card says which:
- **Answer:** the agent is stopped at its own prompt (an approval, or its question tool with choices), and the board answers that prompt. It takes effect at once. The buttons are the host's own options, in its words, limited to those the board may give.
- **Send:** the agent asked in the text of its reply. The board sends a message, and the line under the buttons says when it arrives (D1): now, at its next turn, or "answer in its window".

| How the agent asks | What the board shows | Answer or send, where |
|---|---|---|
| Approval | the command, then Allow once, Deny, and "Deny and say why" where the host takes it | answer: Claude Code, Codex, OpenCode (D3); another host through its route below once that route's check passes. Until then the request and "answer in its window" |
| One choice from options | one button per option (its label, its description small); one tap sends, and the card says "Sent: <option>" | answer: Claude Code's question tool (F14), OpenCode's question tool (F15). Codex's question tool only through its app server: 0.25.1. Cursor's `AskQuestion` and Hermes's `clarify` hold the agent at their own prompt, which a sent message does not answer: the card shows the question and "answer in its window", no buttons |
| Several choices | a box per option and Send | as above, where the host allows several |
| Options plus "Other" | the options and a text box | as above |
| A question in the reply text | buttons when the board reads choices from it ("A or B?"), and a text box | send, with D1's line; on next-turn hosts it says "arrives at its next turn" |
| A password or other secret | no box: "enter it in its window" | never through the board |
| The agent never asks (Antigravity turbo, Codex never or yolo, Claude Code bypass, Hermes off, Grok always-approve, Cursor Run Everything) | no approval card; progress and messages only | send only |

Until a host's route below has passed its check, its card shows the request and "answer in its window", with no button that would only pretend.

### Approvals and questions on the other hosts
The owner, 2026-11-11: 「我還是希望 Antigravity、Cursor、Grok、Hermes、OpenClaw 要有方式 另外 deepseek harness 也要可以」. None of these lets an outside program answer its own prompt the way Claude Code, Codex and OpenCode do, but each has a hook or service that can decide before the prompt or in its place. Each route ships only after its check passes on a live record; until then the card says "answer in its window". A question the agent writes in its reply uses Send (D1, D2). A host's own question tool (Cursor's `AskQuestion`, Hermes's `clarify`, Grok's if it has one) holds the agent at a prompt that a sent message does not answer, so its card says "answer in its window", with no buttons, until a route for that prompt passes a check.

A route may need a one-time step inside that host: turning on a hook or a plugin, or a gateway credential the person sets up. The owner, 2026-11-11: 「有些需要自己在對應的ai 例如你說的deepseek 需要接上hook 需要特別在那接上 這是可接受的」. Each such step is the person's choice, never done by setup on its own; setup's last lines and the host's card say exactly what to do. These steps are counted in the ledger as their own journey, outside the first-install ceilings above.

| Host | Route for Allow and Deny | Its check |
|---|---|---|
| Antigravity | a `PreToolUse` hook waits for the press and returns `auto_approve` or `deny`; with no page open it returns `ask`, so its own prompt shows | F16 |
| Cursor | `beforeShellExecution` and `beforeMCPExecution` wait and return `allow` or `deny`; with no page open, `ask` | F17 |
| Grok Build | its `PreToolUse` hook can only deny. Deny works in any mode; Allow needs the board as the gate (below) | F18 |
| Hermes Agent | `pre_tool_call` can block, which is Deny; Allow needs the board as the gate, or a reply through Hermes's own messaging gateway (`/approve`) | F19 |
| OpenClaw | its gateway resolves an approval (allow once, deny) for an operator client, which needs a gateway credential the person sets up once | F20 |
| DeepSeek Harness | not documented: its board plugin runs inside the host, and may see a tool call before it runs | F21 (after F2) |

**The board as the gate** (Grok, Hermes, and any host whose hook cannot allow): the person chooses, per host, to turn that host's own asking off and let the board's hook decide every tool call that would have asked. Setup never makes this choice: the person turns it on with one command, which the card offers. On Grok a hook that times out or crashes lets the call through, so with Grok's own asking off a failed hook would run a call unasked. The gate ships on a host only if its check (F18, F19) shows that a hook that crashes, times out or cannot reach the board stops the call; on a host where it does not, the gate is not offered, the host keeps its own asking, and its card offers Deny only. With no board page open, the hook denies and tells the agent "open the board to approve", so nothing runs unasked; the agent waits until the person is back. The owner, 2026-11-11, asked deny or let through: 「擋下」.

### GitHub Copilot's first step
GitHub Copilot is the second most mentioned tool among regular agent users (all its surfaces), and the board cannot show it at all. Copilot CLI documents hooks: `preToolUse`, which can allow or deny, and a `permissionRequest` event, with event names that match Claude Code's. Because a patch release adds no hook (line 3), they go into 0.25.0 if F11 passes; otherwise Copilot is not in 0.25.0.
- **F11 first** (half a day, a dated note). It passes only if a live run shows both hooks fire with a session id, tells an approval that is really waiting from a call approved without asking (GitHub documents that `permissionRequest` fires before the permission rules), and clears the request once it is answered in Copilot's window.
- **If it passes:** setup connects Copilot CLI like the other hook hosts (its row, its setup and remove steps, its row states as far as its events show them), and a pending approval shows on its card with "answer in its window". Lane C.
- **Not in 0.25.0:** Allow and Deny for Copilot (they need their own F10 check), answers or messages to it, and the Copilot IDE extension.
- **If it fails:** Copilot is not in 0.25.0, and the note says why.
- **Cost:** about 3 to 5 days, Fable 5.2's estimate if the hook shapes match Claude Code's, and one more live record (M8 line 6).

### D2. Receivers, one pull request per host
In this order: OpenCode (#724: a new receiver on the DeepSeek pattern; wakes an idle session, hands over at `session.idle`), Codex turn end (#319: a `Stop` hand-over without the daemon; and #318, a session on the shared daemon taking a message idle or busy, pull request #1306 already open, which is the wake F6 asks about), Cursor (enroll on any hook event, hand over at `stop`), Hermes, Grok (only if F8 passes). Before the first, a small pull request moves the turn-event block out of `scripts/codex-local.ts:1076-1124` into `scripts/hook-delivery.ts`. Hook changes must land in this version, not a patch.
- **Done when:** per host, the stand-in test passes and the live record marks a, b and c each as `now`, `later` or `cannot` (named), as M8's delivery table does: a and c at `now` or `later` for each host the pull request ships, and b `cannot` only where the cut order has cut it. The card's line agrees with the record. Every record quotes the line the card showed under Send; a record where the card promised one thing and another happened is a FAIL.
- **Test:** stand-in agents prove the wire shape and the store's state; only a live record proves the host obeys. Records are `docs/validation/<date>-<host>-live.md`.

## The checks

Half a day each, a dated note each, before the milestone they feed. The host checks run in the order Fable 5.2 recommended, the checks that decide the most presses first: F6 (Codex) and F15 (OpenCode), then F17 (Cursor), then F11 (Copilot) and F16 (Antigravity), then F18 to F21 (F21 after F2).

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
| F10 | On each host that gets an approval button (Codex, OpenCode and Claude Code, then each other host's route before it ships): can a command inside the agent's session approve its own request, through the address file or otherwise? | D3, other hosts |
| F11 | GitHub Copilot CLI, live: do `preToolUse` and `permissionRequest` fire with a session id; can the board tell an approval really waiting from a call approved without asking; does the request clear once answered in its window? | Copilot's first step |
| F12 | Windsurf: hooks or MCP only. Notes only. | 0.25.1 |
| F13 | Does Claude Code's `PermissionRequest` hook let the board's hook wait for the press and return allow or deny (and Antigravity, if it has such a hook)? Read 2026-11-11 from the hook documentation: yes for Claude Code, one live run left; no documented answer route for Antigravity. | D3 |
| F14 | Does a Claude Code `PreToolUse` hook that returns the answers for its question tool close the question in the terminal and the desktop app, and in what form are several choices and "Other" given? | Answer or send |
| F15 | OpenCode: in the installed version, which routes answer a permission and a question, does a denial take a message, do both reach the event stream, and does a press that carries the request id and the drawn state but no turn answer only that request, on a live record? | D3, Answer or send |
| F16 | Antigravity CLI and IDE: does a waiting `PreToolUse` hook's `auto_approve` or `deny` take the place of the prompt under its default and request-review settings, within its 30 s limit, and does `ask` bring the prompt back? | Other hosts |
| F17 | Cursor IDE and `cursor-agent`: do `allow`, `deny` and `ask` from a waiting `beforeShellExecution` / `beforeMCPExecution` hook all hold? | Other hosts |
| F18 | Grok Build: can the `PreToolUse` limit be raised above the wait; does deny hold in ask and always-approve modes; does a timeout, a crashed hook or an unreachable board let the call through? | Other hosts |
| F19 | Hermes: does a waiting `pre_tool_call` hold the call; with approvals off, does block hold, and does a crashed or timed-out hook stop the call; can the board reply through a Hermes messaging gateway without the person's chat credential? | Other hosts |
| F20 | OpenClaw: can the board resolve an approval through the gateway, and what credential does that take? | Other hosts |
| F21 | DeepSeek Harness: does it ask before a tool runs, and can its plugin see and decide that call? | Other hosts |

## Lanes and merge order

| Lane | Milestones, in turn | Main files |
|---|---|---|
| A, setup and upgrade | M2, M3, M5 | `scripts/codex-local.ts`, `scripts/setup-agent.mjs`, `bin/agent-board.mjs` |
| B, the board | M4, M6, M7 | `scripts/board-cli.ts`, `scripts/board-serve.ts`, `scripts/codex-history.ts`, `hooks/view.ts`, `hooks/digest.ts` |
| C, hosts | M1, Copilot's first step (after F11), then D2 OpenCode, Hermes and Grok hook tables | `hooks/portable-agents.ts`, `hooks/local-agents.ts`, `hooks/receivers/` |
| D, records | M0, then M8 | `docs/validation/`, tests |
| E, delivery | the extraction, D1, D3, D2 Codex and Cursor | `scripts/hook-delivery.ts`, `hooks/hook-messages.ts`, `hooks/receivers/`, `hooks/serve.ts`, `scripts/messaging-matrix.mjs` |

- Lanes A, B, C and E all rebuild the board bundle: one bundle-touching pull request merges at a time, and the next merges main and rebuilds first.
- Lane B's milestones run one after another. M3 merges before M4. The extraction merges on day one; D1 merges before M7, which also changes cards in `hooks/serve.ts`.

## What 0.25.0 must not claim

- "Upgrades itself" for the upgrade to 0.25.0, for an install with no `npx`, or for the Claude Code plugin (its own channel). "0 typed commands" without "from 0.25.0 on, when nothing needs asking".
- "90% automatic" for first install, for an app or IDE person, or for macOS (no run).
- "Your sessions are there" or "at once": the board lists Codex sessions found in Codex's records, marked not connected. No other host.
- Send, Queue or "receives" for an agent or surface with no live record on the 0.25.0 head. "Goes in now" where the record shows turn end or next turn. "Every agent receives" or "no Copy": the release notes print the delivery table's counts instead. "Approve from the board" unless D3 shipped (F10 passed), and never for a host whose route's check has not passed. "Wakes an idle session" for a hook-mailbox host.
- "Opens a window" in any app not shown doing so on the 0.25.0 head (#865).
- "Knows when a conversation ended" for Antigravity, Hermes or a window closed by force, unless a record on the 0.25.0 head shows the process check doing it.
- "Nothing to install": Node 22 or newer and a terminal are needed once.
- "No network use": one request a day, on by default.
- "An agent cannot act as the person on the board": it can. An agent shown the page link, or that looks for it, can act as the person; `SECURITY.md` says so. The fix is 0.25.1.
- "Approve from the board", "answer from the board" or Send for Copilot: if F11 passes, 0.25.0 shows its progress and its requests only.
- "Works with Muse Code" or "Gemini CLI". "Works in <app or IDE>" for a row not run.
- "Stable" before the six gate lines hold.

## Moved to 0.25.1

- **The token redesign:** a link that works once, a page session in no address, a separate credential for the board's own client. It must land before the rest of #1119.
- **The wake for hook-only agents,** `board_wait` (#685), for Codex (if F6 fails), Antigravity, Cursor, Grok and Hermes.
- **One general MCP route** (setup writes the MCP entry, a `board_report` tool, `board_wait`) for Junie, Zed, Amp, Augment and Factory; Windsurf through the same route.
- **Copilot's Allow and Deny** after its own F10 check: in 0.25.1 only if the hook 0.25.0 installs already holds them, since a patch release adds no hook (line 3); otherwise 0.26.0.
- **Cloud bots:** the bridge plan (#866), the trial one release later.
- **Remove polish and setup words that block nobody:** #1244, #1271, #1202, #1245, #1295, #768, #1275.
- **CI flakes** #910, #835, #998, #1135, unless one blocks a merge. The first-try figure is reported, not a gate.
- **Also:** #317, #723, #852, #803, #826, the rest of #844, #1268, #1274; #722; #1014, #548, #1023; #1084, #1164, #1280, #1025, #922, #402; #1283, #1294, #1298; #1228 with #1251, #1137, #1159; #1041, #1066, #1057; #491, #1038, #1277.

## CI and team process

The owner: 「全部加進去」. Lane D carries the first three as issues; the fourth goes in one owner-approved pull request with the hook-freeze rule and the tiered review (#1285); the last two are the maintainer's practice.
1. Tests stop asserting wall-clock limits under 1 s on the shared runner (a fake clock or counted work), and every test file stays under 70% of its time budget; a file over it fails the pull request, not main. #1249 adds a sampler to the Windows test jobs: on any gap over 1 s it records CPU per process, free memory and disk queue length, and uploads them with the job's artifacts, to find the cause of the runner freezes.
2. Check the pull-request-versus-main matrix first: a pull request runs Node 22 Ubuntu and Node 24 Windows, main all four pairs (`docs/dev/CI.md`). Change the split only if a failed main run broke on a pair the pull request never ran.
3. A duplicate-work check: a new issue's title is compared with open issues, and a new pull request for an issue that already has an open pull request is flagged, before either is accepted (#1240 and #1213 were two pull requests for #1203); a lane that files a finding links the pull request it came from.
4. `RULES.md` R1 names the role: "maintainer: reviews, merges, releases, plans no other lane's work". The owner approves it by hand.
5. `scripts/team-stats.mjs` output is posted weekly on #209.
6. dot gets only work that fits one push (it cannot update an existing branch and has no `gh`).

## Scope kept from the first draft

- **In:** #1305, #1302, #1303, #1304 (upgrade); #868, #865, #1272, #1278, #1289 (first install); #1296, #1092 with pull request #1288, #1287, #1290 (status and questions); #557 (the next-turn record); #851 (the ledger, a CLI person and a UI person per agent, per-agent parity summaries); #1297 (one place for record screenshots); #1276 (owed from the 0.24.3 outside read); #1249; OpenClaw and DeepSeek Harness; Gemini CLI retirement. New issues, opened 2026-11-11: the ledger and J11 (M0) #1313, the update entry and ask rule (M3) #1314, the daily check and its start (M4) #1315, Codex sessions from its records (M6) #1316, the six row states (M7) #1317, approvals on the board (D3) #1318, the answer-or-send controls #1319, the approval routes on the other hosts #1320, the checks F1 to F21 #1321, every AI tested live (M8 line 6) #1322, and CI items 1 to 3 #1323, #1324, #1325. Receivers taken back from blocked, 2026-11-11: #724 (OpenCode), #319 (Codex turn end), #233 (Hermes), #726 (OpenClaw), under the parent #686.
- **README (#1267)** is in flight outside this plan; its pictures show only the seven agents with live records, and Muse Code leaves the support table in all three languages.
- **Process, no version:** #1285, #1257 with its pull request #1259, #1258.
- **May close, each after its check:** #884 (every skill reads `--json`; the MCP part is #723), #810 (only if a real SSH terminal can be tried), #1161 (each open item has its own issue).

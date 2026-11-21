# Plan for 0.25.1

**Status:** in force since 2026-11-18. Amended the same day with the results of checks C1 to C5 and C8 and the owner's decisions on them, and on 2026-11-19 with decision 7 (section 14). The issues live in milestone 14, "0.25.1 It updates itself". The roadmap is #209.

**Where it comes from:** a Fable 5.2 review of the whole project after 0.25.0, a draft plan, two outside reviews of that draft (21 must-fix findings, answered in section 15), and the owner's decisions of 2026-11-18.

**The owner's bar for this release:** 「我需要最全面的，意思是说，要让使用者能够体会到我们的好。」 The plan is judged by what a person feels when using the board, so section 1 comes before any milestone.

**Words used.**
- *Hook change:* a hook added, removed or reworded, in an agent's configuration or in the plugin's `hooks/hooks.json` (RULES R7). A script that a hook already runs may change while its command text stays the same (owner, 2026-11-18).
- *A person's open:* the page, holding its page secret, reporting that it is visible in a browser; or the terminal board in an interactive terminal with none of the agent variables in `hooks/surface.ts` set. A headless agent run, CI, `--json`, `--status`, `--report` and hooks never count.
- *Release build:* the package packed from the release pull request's head, the same bytes npm will get (`docs/validation/USER-SIM.md`).
- *Candidate:* that version published to npm's `next` tag, before it moves to `latest`.
- *Stand-in:* a test program that plays a host.

## 1. What the person will feel

Each moment has a number. The simulated user measures all eight on the release build and writes the value beside the bar. A value over its bar is a FAIL, and under `docs/RELEASING.md` gate 5 a FAIL stops the release (gate line 12).

| # | The moment | Today, 0.25.0 | The bar for 0.25.1 |
|---|---|---|---|
| 1 | A new version arrives | The person finds out alone and types the commands: 5 of 11 steps in the 11-10 walk | From 0.25.1 on, with npm, they open the board as usual and one line says it updated: **0 steps**, or **1 confirm** when something must be asked. A person with only the Claude Code plugin is told on the board and does **2 steps**: update the plugin, start a new session |
| 2 | A reply on the board starts the AI | Codex CLI about 10 minutes; Antigravity app only on its next turn; Claude Code CLI acknowledged in about 15 s; OpenCode accepted in 0.9 s | The turn starts with no step in that AI's window, within **10 s** on Claude Code CLI and the Antigravity app, **2 s** on OpenCode, and after **about 10 minutes** on Codex CLI, which the board says (check C1) |
| 3 | Sessions already open are there | A Codex session that has not reported since the board started is missing | Within **10 s** of opening, Codex sessions from Codex's own records of the last 24 hours are listed. A hook event shows on the page within **2 s** |
| 4 | The board opens, or says why not | A dead page process can hold the message store and refuse the board (#1587); a failed open can reach the model as no output (#1596) | After a dead page the board opens within **10 s** with no step. If it cannot, it says why and names **one** action |
| 5 | A card leaves when its window closes | The card stays in Needs you (#1092) | Gone within **60 s** for Claude Code and for a Codex session with a process record. Any other card says the window may be closed |
| 6 | An approval is safe | A same-account program that writes the address file can approve silently (F10) | A program that writes the address file and listens on a port, as in F10, **receives nothing and approves nothing**, and Claude Code's own prompt appears. A program built to forge the board's identity is not stopped (section 4) |
| 7 | First install | 7 steps (Windows, Codex only) | **3 steps** on Windows with Codex only, **6** on Linux with four agents |
| 8 | A bad update | Automatic updates do not exist yet | If the new page does not answer or a report does not arrive, the board **returns to the previous version by itself**, reports keep arriving, and it does not retry that version |

**The one move that cannot be automatic.** 0.25.0 has no version check, so going from 0.25.0 to 0.25.1 still costs **3 steps** with npm (learn of it, one command, one answer) and **3 with the Claude Code plugin** (learn of it, update the plugin, start a new session). Every release after it follows moment 1.

## 2. Scope and date

The owner's answers of 2026-11-18:

| Question | Answer |
|---|---|
| Antigravity starts on a board message | Not in 0.25.1. After check C3 the owner accepted three windows (two on 2026-11-18, a healthy hook's blind time on 2026-11-20) with a hard stop; #1612's extra review round found a wake into a running turn outside them, so the wake moves to 0.26.0 (owner's rule, 2026-11-20). The app keeps the next-turn route |
| App and IDE rows | Two sittings: discovery on released 0.25.0, then a short rerun on the release build |
| Codex starts at once | Not in 0.25.1. Check C1 failed, so Codex keeps the 10-minute route, the support table says so, and #1652 moves to 0.26.0 (owner, 2026-11-18). The remaining window of #1370 is accepted with a test and honest card wording |
| Sessions listed at once (#1316) | In 0.25.1, and the date moves |
| Releases | 0.25.1 has no hook change. 0.26.0 carries all hook changes |

**What this costs.**
- **Date:** about **5 working weeks** from approval. This is an estimate. The last release planned five lanes and delivered about one lane's worth in its first 7 days.
- **Size:** **43 issues** stay (section 8), more than the "about 30" first agreed, because the fullest scope adds sessions at once, first install and the writer-safety fixes.
- **npm:** **two one-time codes**, one to publish the candidate and one to promote it. A defect found after publishing needs a new version and another code (section 7).
- **The owner's time:** two sittings (section 6).

**Nothing is cut for time.** If the work runs late, the date moves. An item leaves only when its check proves it needs a hook change, which R7 forbids here. That goes back to the owner with the measured reason (section 10).

**Leaves for 0.26.0:** a Codex start at once (#1652); the Antigravity wake (#1396, #1609, #1612); receivers for Cursor, Grok, Hermes and OpenClaw; Codex and OpenCode approval buttons (#1318 rest, #1320); the six row states (#1317 rest); the MCP route (#685, #722, #723); agent sending (#317); the phone (#866); notices that open a card (#1014, #548, #1023).

## 3. Milestones

Every milestone names what it covers, the test that locks it, its issues and its R7 status. M2, M3, M4, M5a, M6 and M8 are risk tier.

### M0. Checks and the first sitting (days 1 to 4, in parallel)

Each check takes about half a day and ends in a dated note under `docs/validation/`. A result changes its milestone before code is written.

| Check | Question | If it fails |
|---|---|---|
| C1 | Codex CLI, Windows and Linux: can the script Codex's hook runs name the Codex terminal process within the hook's time limit, and does that process live as long as the window? | M5a cannot ship as designed. Back to the owner with the measured reason |
| C2 | What does finding a port's listener and its command line cost inside the approval hook on Windows? Limit: 2 s added | Over budget, the hook returns no decision and the card says to answer in the window |
| C3 | Can both timing windows of #1396 be closed with no hook change? | R7 forbids it here. Back to the owner: hold the release or move the wake to 0.26.0 |
| C4 | Why did an upgrade drop Codex's hook approval when the hook text had not changed (#1303)? | "Trust not confirmed now" becomes an ask, and the Codex ceiling for the 0.25.0 upgrade becomes 4 steps |
| C5 | Does a plugin update replace `scripts/claude-approval.mjs` for a running session or only a new one? Is `claude plugin update agent-board@agent-board` the right command? Can the person turn on automatic updates for this marketplace? | The release notes carry what the check finds. The plugin walk in gate line 10 stays |
| C6 | Does Claude Code's inbox socket exist in the desktop app's Code tab and the VS Code extension? | Those rows read "cannot, because". Nothing is built in 0.25.1 either way |
| C7 | The Windows `[Y/n]` setup in a real terminal (F5 of #1321), unrun for three releases | A bug issue, fixed in M10 |
| C8 | Can the version check reach npm from inside Codex's sandbox and the Codex app (F4 of #1321)? | The check runs only from the page server; a sandboxed run shows the line and the command |

**Results, 2026-11-18:** C1 failed, C2 passed, C3 failed, C4 passed, C5 passed with one step count still to take, and C8 is partial. C6, C7, the C5 count and C8's elevated sandbox and app rows wait for sitting 1. The notes are `docs/validation/2026-11-18-c*.md`.

**Done when:** eight notes and the first sitting record exist. **Issues:** #1321 (part), #1322 (part), #286 (part), #557. **R7:** no hook.

### M1. An upgrade never stops, and never damages a file

- **Work:** an edited generated file is never overwritten. Text a host reads gets the new file beside it. Code a host loads keeps the old files and says so. Files a release stops writing are removed only when their bytes are still ours, re-read just before the removal (#1488). A file with bytes that are not valid UTF-8 keeps them (#1607). Hermes is not skipped when `config.yaml` holds an earlier release's hooks (#1588). `--json` through an older script fails with a notice, and the page notice of #1304 ships with this work.
- **Done when:** on Windows and on Linux, the upgrade case of the 11-10 walk passes with the person's line still on disk; a home with Gemini and Antigravity ends with Antigravity byte-equal; a Big5 config survives byte for byte.
- **Covers:** every setup agent. **Test:** `tests/host-upgrade.test.mjs`: edited skill, edited hook runner, dropped file, changed-just-before-removal, invalid UTF-8, Hermes config of an earlier release. `tests/npm-package.test.mjs`: an older script with `--json`.
- **Issues:** #1302, #1304, #1488, #1588, #1607. Takes over #1328. #1327 and #1337 moved to 0.26.0 (decision 7). **R7:** no hook.

### M2. One update entry, and when it asks

- **Work:** `setup --update`. It asks only when a hook's command changed, when a file a host loads as code changed, when the host does not confirm now that it trusts the board's hooks, or when the release marks new network use or file reading. Otherwise it updates and prints one line. What the person turned off stays off.
- **The first move:** the 0.25.1 launcher finds an older installed script and runs this entry with one question. Installed skills and commands run the installed script directly, so the first upgrade must start from the new package; the notes and the README give that command.
- **The one question for 0.25.0 to 0.25.1 says what is new:** a daily version check, and reading the list of Codex's sessions (folder, start time, id, last-written time, never the conversation). Each has an off switch.
- **A crash cannot leave a half-written home:** writes are staged with a journal, the manifest is written last, and the next start finishes or undoes the journal.
- **Done when:** J11a (0.25.0 to 0.25.1) counts 3 steps; J11b (0.25.1 to a locally built next version) counts 0 with nothing to ask and 1 with something; a revoked approval stays revoked.
- **Covers:** all setup agents, the launcher, Windows and Linux. **Test:** J11a and J11b in `tests/host-upgrade.test.mjs` with a step counter; one case per ask condition; a person's hook after the board's keeps its slot (#1661); setup from a Node in another folder (#1662); a process killed at each activation boundary, with the board running, then recovered; one dated manual row with a real Codex.
- **Issues:** #1314, #1303, #1661, #1662, #1305 (part). **R7:** no hook.

### M3. The board learns of a new version and updates itself

- **What is wrong with it:** the board fetches and runs new code from npm with no press. The owner accepted this on 2026-11-11 (「可以，自己升級」). The limits below are the price.
- **Check:** one request a day for the `latest` version number, on by default, with an off switch, never from a hook, never holding up `--json` or `--status`.
- **Start:** on a person's open, with a newer version known, the installed script starts `setup --update` for that exact version in the background. With something to ask, the page shows one confirm with the exact commands. A plugin-written script is never updated through `npx`; it shows a line naming the plugin update.
- **Restart:** readiness comes from the stored delivery states, not from a count of running sends. While draining, the board admits no new send. Queued messages, claims, pending acknowledgements and approval watches are kept. A restart is never forced: if the board cannot drain, it stays on the running code and says "restart the board to finish".
- **Way back:** the update journal and the whole previous install (script, workers, skills and generated files) are kept until the new version passes a health check: the page answers and a test report reaches the board. If it fails, the board restores that whole set, keeps any file the person edited since, and does not retry that version. A registry `latest` lower than the installed version is a stop signal. The notes carry the manual way back as one tested command.
- **Quiet:** the "different build" launcher line (`bin/agent-board.mjs:293`) stays silent for a version the updater installed.
- **Settings:** this adds settings, so the plugin and the board script stop dropping each other's writes (#1312).
- **Done when:** a real `npx` against a local registry on Windows, started from Codex CLI and from Claude Code, updates the home with no command typed; with the switch off no request leaves the computer; a dead registry costs under 2 s; a broken new page returns to the old version, and a report still arrives afterwards.
- **Covers:** page and terminal board, Codex CLI in its sandbox. **Test:** `tests/npm-package.test.mjs`: one request a day across concurrent commands, off means none, dead endpoint, an agent's plain board command does not start an update, lower `latest` stops. `tests/host-upgrade.test.mjs`: a failed health check restores the whole previous install, a report arrives after the return, an edited file survives it, and that version is not retried. A restart case with a queued message, a claim and an approval watch.
- **Issues:** #1315, #1312. **Also changes:** `SECURITY.md` says what runs, when, and how to turn it off. **R7:** no hook.

### M4. The approval hook checks who is listening

Section 4 holds the design.
- **Done when:** runs 2 and 3b of the F10 note, repeated against the new script, end with no decision and Claude Code's own prompt; the real board still answers; a plugin at 0.25.1 accepts a later board and a 0.25.0 plugin still works with a 0.25.1 board.
- **Covers:** Claude Code CLI on Windows and Linux. macOS returns no decision (section 14, question 5).
- **Test:** `tests/approvals.test.mjs`: "an address file naming a process that does not listen on its port gets no request"; "a listener that is not the board script never sees the command"; "the lookup timing out prints nothing"; "the off switch stops the hook before it contacts the listener"; "a process id whose command line reads empty is refused" (C2); both version directions.
- **Issues:** #1651. **R7:** no hook change; gate line 9 proves it.

### M5a. Codex delivery says what really happened

- **Why the scope changed:** check C1 failed. On the shared server the server runs the hook, so the hook cannot name this session's window, and a live `codex.exe` cannot stand for "a person is there". Codex keeps the 10-minute route (owner, 2026-11-18), and #1652 moves to 0.26.0.
- **Work:** the receiver re-reads the thread's state right before `turn/start`, which narrows #1370; the card says plainly that a message sent while the person starts a turn may join that turn. A claimed message that never started is shown as not started (#1507). A person who quits during the receiver's watch is not read as still on the thread, or the docs say the window (#1504).
- **Done when:** the cases below pass, and the support table and the card say "after about 10 minutes" for Codex CLI.
- **Covers:** Codex CLI. The desktop app is a sitting row. **Test:** `tests/messaging.test.mjs`: a person's turn starting just before `turn/start`; a claimed message that never started; a disconnect keeps the earlier settled reason; a quit during the watch.
- **Issues:** #1370, #1507, #1504, #1613 (part). **R7:** no hook change.

### M5b. Antigravity starts on a board message

- **Moved to 0.26.0 on 2026-11-20, by the owner's hard stop below:** #1612's one extra review round (codex_618 on ca554d21) found a wake into a running turn outside the three accepted windows: a turn start whose record cannot be made can be read idle before its count is written. So #1612, #1396, #1609, #1750, #1751 and #1752 move to 0.26.0 with no further patch, and the app keeps the next-turn route in 0.25.1. Only #1384 stays here.
- **Work:** finish #1612. One live run first settles whether `agentapi get-conversation-metadata` prints `num_steps`, whether it rises as soon as a turn starts, and how long the call takes. The hook worker writes the turn's mark first, so a slow hook no longer lets a wake into a running turn. A dismissed failed wake no longer holds the next message's wake (#1609). Fix the `agy` report that fails with permission denied, so its questions reach Needs you (#1384).
- **Accepted by the owner on 2026-11-18, after check C3:** a turn-start hook that never ran, and the 0.25 to 0.54 s between the board's yes and `send-message` landing. Antigravity offers no "send only if idle" and no public run status, so neither window can be closed from the board. The card says plainly that a message sent while the person starts a turn may join that turn.
- **Accepted by the owner on 2026-11-20, after #1612's round cap and design diagnosis 4 on #1396:** a third window, the time from a healthy turn-start hook's command to its start record (58 to 94 ms in C3's runs) plus the app's own delay before it launches the hook. #1612 gets one more push, a start record made before any lock (#1750, #1751, #1752), and one review round. If that round finds a wake into a running turn outside the three windows, the wake moves to 0.26.0 with no further patch. A review treats only these three windows as accepted.
- **Done when:** #1384: an `agy` report's questions reach Needs you. The wake's live record (an idle start within 10 s and a running turn held) goes with it to 0.26.0.
- **Covers:** the Antigravity desktop app and `agy`. **Test:** an `agy` report case. #1612's case table, one row for each accepted window, and the dismissed failed wake go with the wake to 0.26.0.
- **Issues:** #1384. #1396 and #1609 moved to 0.26.0. **R7:** no hook change; C3 found that none would close these windows.

### M6. A dead page cannot lock the board

- **Work:** the board takes over a message store only after proving the old owner has ended: it confirms by command line that the process is the board, ends it, and waits for it to exit. If that cannot be proven, it refuses and names the one action to take. A board command that could not open the page says so in words an agent repeats.
- **Done when:** moment 4 holds on Windows and Linux.
- **Covers:** every agent's board command, page and terminal board. **Test:** `tests/e2e/l3c-message-store-ownership.test.mjs`: a live process that holds the lock and listens nowhere is replaced; **an old owner that resumes after replacement cannot write**; a process that cannot be proven to be the board is refused. An OpenCode command case with a failed open.
- **Issues:** #1587, #1596. **R7:** no hook.

### M7. What the board shows is true

- **Work:** a closed window takes its card with it. Close detection does not depend on C1: Claude Code uses its process, and Codex uses its process record where one exists and `SessionEnd` otherwise. A process walk that reaches the shared server stops there and reports unknown (C1). A Codex card with neither says "the window may be closed", with one action. An `agy -p` row ends. The support table gains "after a wait". One wording for one Codex situation. The Claude Code pane's count matches the page.
- **First step:** answer on #1092 whether the task stays locked after the card leaves, before taking over #1288.
- **Done when:** moment 5 holds, and a card with no close signal never claims the window closed.
- **Covers:** Codex, Claude Code, Antigravity; page and terminal board; `docs/MESSAGING.md`. **Test:** a stale-card case in `tests/e2e/l4-time.test.mjs`, run with and without a Codex process record; the route-record test.
- **Issues:** #1092, #1296, #1589, #1643. Takes over #1288. **R7:** no hook.

### M8. The person's presses need the page

- **M8a, first:** no reusable credential on stdout when a window opened. The update confirm and both switches require the page secret (`SECURITY.md:49`).
- **M8b:** each route is listed in a capability table. Person-only routes refuse the address-file token. Receiver and control routes keep it: the approval ask, open and ping, register, poll, receipt, disconnect, the mailbox and the Antigravity wake. Answers from the terminal board stay on the address-file token (`scripts/board-cli.ts:1997`), and `SECURITY.md` says so.
- **Done when:** a send made through a person-only route with the address-file token is refused; every receiver and control route still works; no stdout line holds a reusable credential on open, failed open, SSH or `--no-open`.
- **Covers:** every agent with a board command. **Test:** `tests/messaging.test.mjs`, one case per row of the capability table; a stdout case per fallback.
- **Issues:** #1650, #1119 (part). **R7:** no hook.

### M9. Sessions already open are listed at once

- **Work:** new bounded code lists Codex's own session records, newest first: folder, start time, id and last-written time, never the conversation. Each record is read as `readSessionMeta` in `scripts/codex-history.ts` reads one: in pieces of 4 KiB up to the first line break, at most 256 KiB in all. Up to 4 KiB after the break can reach memory in the last piece; it is never decoded, kept or logged. Only the named fields of the first line are kept. Only records written in the last 24 hours, at most ten, without helper threads or program-started runs. They sit in a folded group, "Seen in Codex's records, not connected", and do not count under Working or Needs you. The row says what makes it connect.
- **Done when:** with one session reporting and two only in the records, the board shows one normal row and two in the folded group within 10 s of opening; a record holding conversation text proves none reaches the board or `--json`.
- **Covers:** Codex CLI and app records, page and terminal board. **Test:** fixtures for an empty board, the mixed case, a helper thread, a `codex exec` record, an old session written to an hour ago, a record over 24 hours old. A test of the read itself: no more than 256 KiB is read, text after the first line break is never decoded, and a first line over that limit skips the record.
- **Issues:** #1316. **Depends on:** #1593 for the 2-second page update. **R7:** no hook.

### M10. First install in three steps

- **Work:** the README's one command previews, asks one question, sets up the agents found, approves Codex and Hermes hooks, installs the Claude Code plugin where present and opens the board. Next steps print whole commands (#1272), list only what a repair needs (#1278), and `--agent claude` points to the plugin (#1289).
- **Done when:** walked in a real Windows terminal and a Linux pseudo-terminal, ending in a real session's row, within the ceilings of moment 7.
- **Covers:** setup on Windows and Linux, three languages. **Test:** the pseudo-terminal journey in CI; a dated manual row on Windows; `setup-guidance` cases.
- **Issues:** #1272, #1278, #1289, #865, #868. Continues #1356 after its design question is answered. **R7:** no hook.

### M11. Proof

The step ledger and J11 in `docs/validation/USER-SIM.md`; one real reply per receiving host with its seconds; a time budget in every stand-in route test; parity and simulated-user records on the release head; the walks of gate line 10; the four test fixes.

**Issues:** #851, #1297, #1313, N3 to N7 (section 7), #1249, #1639, #1641, #1646, #1647. **R7:** no hook.

## 4. The F10 fix, exactly

**The hole:** the hook reads the address file, posts the request with the command in it to whatever listens on the named port, and obeys the answer.

**What the script verifies before it sends anything:**
1. The address file's process id is the process listening on `127.0.0.1:<port>`, by the system's own table.
2. That process is Node, and its command line names the board script at an expected path directly before `--serve-child`: beside the progress file, `~/.agent-board/agent-board.mjs`, or the plugin's own copy.
3. The off switch is not set. The page switch writes a local marker, and the hook reads it before it contacts the listener.
4. Any failure, timeout or system with no lookup prints nothing, so Claude Code shows its own prompt.

**No hash list.** A list frozen into the plugin would reject a real board after the board updates itself. The path and process checks do not depend on the board's version.

**When the check refuses,** the hook leaves a small local record with the reason and no command text. The board reads it and shows "update the plugin" or the reason, so approvals never vanish without a word.

**What a same-account program can still do.** This narrows the hole and does not close it.
- Forge its command line to look like the board.
- Change the installed board script or the plugin's files where it can write there.
- Start the real board with injected code, drive the browser, or read the page key from the browser's command line (`SECURITY.md:51`).

`SECURITY.md:53` will say this. The advice stays: on a computer where such a program might run, answer in each agent's window.

**How it reaches people.** The hook ships in the Claude Code plugin, which does not update through npm and, per Claude Code's documentation, does not update itself from a third-party marketplace (C5 checks this live). The release notes lead with the exact commands (C5 found two: `claude plugin marketplace update agent-board`, then `claude plugin update agent-board@agent-board`) and the sentence "you are not protected until you run this and start a new session".

## 5. The Codex wait

C1 failed (`docs/validation/2026-11-18-c1-codex-terminal-process.md`). The owner decided on 2026-11-18: Codex keeps the 10-minute route, and the support table says "after about 10 minutes". #1652 moves to 0.26.0 to look for another sign that a person is at the window.

## 6. The owner's two sittings

**Sitting 1, day 1 or 2, on released 0.25.0.** It finds what is broken before code is written. About two hours; it continues the next day if it runs over, and nothing is skipped.

**Sitting 2, after code freeze, on the release build.** It reruns every row whose path changed, as `docs/validation/PARITY-CHECKLIST.md` requires. Likely about an hour, at most the same two hours.

| # | Row | What is done |
|---|---|---|
| 1 to 8 | Claude desktop app, Claude Code IDE extension, Codex desktop app, Codex IDE extension, Antigravity app, Cursor IDE, VS Code with Copilot, Devin Desktop | Checks a to f of the parity list. An app that is not installed is written "not installed" |
| 9 | Claude desktop Code tab and Codex desktop app | One board message to an idle session: starts, next turn, or cannot |
| 10 | Windows terminal | The `[Y/n]` setup (C7) |
| 11 | Codex CLI, `agy`, Grok | `/agent-board` opens a window |

## 7. The release gate

Lines 1 to 4 are the gates of `docs/RELEASING.md`. Line 4's set is the must-ship list in milestone 14's description, which this plan fills in. Each new line has one must-ship issue, so a line that is not met keeps 0.25.1 from going out as stable. Each line is run by someone who did not write that milestone, and the record says who.

1. CI is green on Ubuntu and Windows on the tagged commit.
2. The parity record for 0.25.1 exists, and every FAIL names an open issue outside the must-ship set.
3. The L1 to L3 journey tests and the upgrade journeys pass.
4. Every must-ship issue is closed.
5. **Steps (#1313).** J11a at most 3 (4 for Codex only if C4 failed); the plugin walk at most 3; J11b 0 and 1, and at most 2 through the plugin; first install at most 3 on Windows with Codex only and 6 on Linux with four agents.
6. **Seconds (N3).** A live record per receiving host at or under moment 2's ceiling, and Codex sessions listed within moment 3's 10 s. Every stand-in route test asserts a budget. A value over its ceiling fails.
7. **Sittings (N4).** No `needs owner` cell is left after sitting 2. A cell held by a vendor's usage limit stays open until the owner accepts it by hand on the issue.
8. **F10 (#1651).** Runs 2 and 3b repeated: no decision, and the real board still answers. Claude Code with its own Bash sandbox on is run as well.
9. **Hook declarations (N5).** A test compares the complete generated hook declarations with 0.25.0's, under identical synthetic system, path and Node contexts: events, matchers, timeouts, groups, additions and removals.
10. **Real walks (N6).** On the release build from a local registry, starting from the command the README prints: (a) a 0.25.0 home with a real Codex, Hermes not skipped, Codex trust read back; (b) a plugin-only home; (c) a home with both plugin and npm (J11c); (d) a real `npx` update from Codex CLI and from Claude Code on Windows; (e) a broken update that returns by itself. Walks (a) and (b) run once more from npm after the candidate is published.
11. **First try (N7).** The tagged commit is green on its first attempt. A failure holds the release until its cause is fixed; opening an issue does not satisfy this line. A rerun counts only when the log shows a runner outage.
12. **The eight moments (#851).** The simulated-user record lists each moment of section 1 with its measured value. A value over its bar is a FAIL.

**How it is published.**
1. Walk line 10 on the release build, so a defect is fixed before a version number is used.
2. Tag and publish to `next` (first one-time code). The daily check reads only `latest`, so the updater offers the candidate to nobody.
3. Repeat walks (a) and (b) from npm.
4. Promote with `gh release edit` and `npm dist-tag add` (second one-time code).

A version number can be used only once on npm. If a walk finds a defect after publishing, 0.25.1 stays off `latest`, the fix ships as 0.25.2 with the same must-ship list, and the changed rows run again.

The READMEs use `@next`, so both tags must end on the version that is promoted. People following the README get the candidate during the walk, so the walk is kept to two days. `docs/RELEASING.md` gains this move.

## 8. Milestone 14, re-cut

**Nothing moves until this plan is approved.** Each move is checked at its issue page first.

**Stay: 42 open issues plus N3** (N4 to N7 are gate issues opened with it).

| Milestone | Issues |
|---|---|
| M0 | #557, and in part #286, #1321, #1322 |
| M1 | #1302, #1304, #1488, #1588, #1607 |
| M2 | #1303, #1314, #1661, #1662, and in part #1305 |
| M3 | #1312, #1315 |
| M4 | #1651 |
| M5a | #1370, #1507, #1504, and in part #1613 |
| M5b | #1384 (#1396 and #1609 moved to 0.26.0) |
| M6 | #1587, #1596 |
| M7 | #1092, #1296, #1589, #1643 |
| M8 | #1650, and in part #1119 |
| M9 | #1316 |
| M10 | #865, #868, #1272, #1278, #1289 |
| M11 | #851, #1249, #1297, #1313, #1639, #1641, #1646, #1647, N3 |

**Must-ship:** every issue above except the "in part" ones, plus N3 to N7. The "in part" issues stay open or are narrowed, because this release does not finish them: #286, #1119, #1305, #1321, #1322, #1613.

**The rest, about 140 issues.** An issue moves to 0.26.0 if it adds or changes a hook or belongs to the list in section 2. It moves to a backlog milestone if it is page polish not seen in a 0.25.0 simulated-user run, contributor tooling, or research.

**Close only after a check, with evidence:** #758, #803, #1084. **Not closed without one:** #826 (live runs are still missing) and #1257 (the short-hash pattern is still in `scripts/pr-check.mjs`).

## 9. Who does what, and in what order

| Lane | Milestones | Main files |
|---|---|---|
| A, setup and upgrade | M1, M2, M3, M10 | `scripts/codex-local.ts`, `scripts/setup-agent.mjs`, `bin/agent-board.mjs`, `tests/host-upgrade.test.mjs` |
| B1, the board's truth | M6, M7 | `scripts/message-store-claim.ts`, `scripts/board-messaging.ts`, `hooks/session-liveness.ts`, `hooks/receiver-routes.ts` |
| B2, the page | M8, M9, M4's page work and shared strings | `hooks/serve.ts`, the three string tables, `scripts/board-serve.ts` |
| E, delivery | M5a, M5b | `scripts/codex-receiver.mjs`, `scripts/session-liveness.ts`, `hooks/blocks.ts`, the Antigravity files of #1612 |
| S, the hook script | M4's script | `scripts/claude-approval.mjs`, `tests/approvals.test.mjs`, `SECURITY.md` |
| D, records and CI | M0, M11, the four test fixes | `docs/validation/`, `.github/workflows/` |

Every pull request that rebuilds the board bundle merges one at a time. `SECURITY.md` is edited by S first, then A and B2. `scripts/board-serve.ts` and `scripts/board-cli.ts` are shared, so their work merges in this order: M6, M8a, M3, M8b. M8a comes before M3 because the update confirm needs the page secret.

| Days | Work | Checkpoint |
|---|---|---|
| 1 to 4 | M0 checks in parallel, sitting 1, the pull requests below; M1, M4 and M6 start | |
| 5 to 7 | M1 finishes; M2, M5a, M5b and M7 start after their checks | **Day 7:** if M1 is not merged, lanes B and E stop and help lane A |
| 8 to 14 | M2, then M3; M5a, M5b, M8a, M9, M10 | **Day 14:** M2, M4 and M6 merged, or the owner gets a new date that day (the live M5b run moved to 0.26.0 with the wake) |
| 15 to 20 | M3, M8b, M10 finish | **Day 20:** code freeze |
| 21 to 25 | M11 on the release build, sitting 2, walks, candidate on `next`, promote | |

**Open pull requests first.**

| PR | What it needs | Who | By |
|---|---|---|---|
| #1621 (F10 notes) | Leave draft and get a non-author review | Lane D | Day 2 |
| #1645 (#1639) | Fix `pr-check` | Its author | Day 2 |
| #1593 (page update within 2 s) | A review of head `e8cf9d6f` | Its author posts Ready | Day 3 |
| #1356 (setup commands) | The maintainer's design answer, then lane A continues it | Maintainer | Day 3 |

**Taken over or closed, each checked first.**
- **#1328:** lane A re-cuts it into two pull requests, edited files and `--json`. It carries six rounds of review; the new pull requests say so and do not treat the count as reset.
- **#1337:** moved to 0.26.0 with #1327 (decision 7), where two pull requests replace it.
- **#1288:** lane B1 takes it over once #1092's lock question is answered.

## 10. If it runs late, or a check fails

- **Late:** the date moves. The owner hears at the day 7 and day 14 checkpoints.
- **A check proves a hook change is needed:** R7 stops it here, and the owner decides between holding the release and moving that item to 0.26.0. C1 and C3 went to the owner on 2026-11-18 (section 2).
- **Never shipped around:** the F10 fix, the way back, the page secret on the update confirm and switches, and any gate line.

## 11. Alternatives considered

| Alternative | Why not |
|---|---|
| Hash list of known board scripts in the hook | It rejects a real board after an automatic update and silently stops approvals |
| A secret file the hook checks | A same-account program can read any file the board can |
| A private pipe that reports the peer process | A new transport in a patch release; Windows needs a native call Node lacks. Look again in 0.26.0 |
| An "Update" button, no automatic start | Adds a step every release. The button remains for the case with something to ask |
| Take over a store when no port answers | An old owner paused at startup can resume and erase the new owner's messages |
| Cache the Codex process start time | A reused process id could pass and start a turn in a closed window |
| Lower the Codex wait back to 65 s | Reopens the hole #1608 closed |
| Count a live `codex.exe` as the person's window | Check C1: the shared server has that name and outlives the window, so a turn could start in a closed window |
| Hide the token on stdout only | The test passes while an agent can still act as the person |
| Move the wake, #1316 and first install to 0.26.0 | The owner chose the fullest scope and accepted the later date. The wake moved later anyway, by M5b's hard stop |

## 12. Files to change

| File | Change | For |
|---|---|---|
| `scripts/codex-local.ts`, `scripts/setup-agent.mjs` | Conflict rules, removal re-check, byte-safe rewrite, Hermes merge, journal, `--update`, ask rule | M1, M2, M10 |
| `bin/agent-board.mjs` | Older script runs the update entry; `--json` notice; quiet line | M1 to M3 |
| `scripts/board-cli.ts`, `scripts/board-serve.ts` | Daily check, start, drain, health check, way back, "could not open" words | M3, M6, M8 |
| `scripts/message-store-claim.ts`, `scripts/board-messaging.ts` | Proven takeover | M6 |
| `hooks/serve.ts`, three string tables | Update line and confirm, refusal line, switches, person-only routes, folded group | M3, M4, M7 to M9 |
| `scripts/claude-approval.mjs` | The checks of section 4, refusal record, off marker | M4 |
| `scripts/codex-receiver.mjs`, `scripts/session-liveness.ts`, `hooks/session-liveness.ts`, `hooks/blocks.ts` | State re-read, close detection | M5a, M7 |
| New bounded code for Codex's records | The list of M9 | M9 |
| Antigravity files of #1612 | The hook worker's turn mark, the wake gate, report fix | M5b |
| `hooks/receiver-routes.ts`, `hooks/receiver-record.ts`, `docs/MESSAGING.md` | "After a wait", Claude's record | M7 |
| `hooks/board-script*.ts` | Generated; rebuilt, never edited | All |
| `SECURITY.md`, `docs/RELEASING.md`, READMEs | What runs and what remains; the `next` move; first-upgrade command | M2 to M4, M8, M11 |
| Tests named in each milestone, a hook-declaration test | Locks each change | Gate |
| `docs/validation/USER-SIM.md`, dated notes | Ledger, J11, C1 to C8, sittings, moments | M0, M11 |
| **Not changed:** `hooks/hooks.json`, hook declarations in `hooks/local-agents.ts` | R7 | |

## 13. Roadmap past 0.25.1

| Version | Theme |
|---|---|
| 0.26.0 | Every hook change in one release, the first to arrive by itself: retiring Gemini CLI on upgrade (#1327), the Antigravity wake (#1396), remaining receivers, desktop apps through the vendor's own door, Codex and OpenCode approvals, six states, notices that open a card, agent sending (#317), one MCP route (#685, #722, #723) |
| 0.27.0 | Agents use the board: hand-off; the cloud-bot bridge plan |
| 0.28.0 | Away from the desk: the phone sends and answers; the server starts at login |
| 0.29.0 | The first cloud bot reads what the person shared |
| 0.30.0 | Cloud bots both ways, never approving |
| 1.0.0 | A promise: frozen shapes, every listed host live each release, macOS, the two bars as gate numbers |
| 1.x | A communication panel for several bots and agents |
| 2.0 | A published shape that outside hosts join without our code |

## 14. Owner decisions

The owner took the proposed answer on all six, 2026-11-18: 「都按照预设吧」.

| # | Question | Decision |
|---|---|---|
| 1 | After 0.26.0: agents use the board first, or the phone first? | Agents first |
| 2 | Standing allow rules: drop them, or after 1.0? | After 1.0 |
| 3 | May a board message reach the Claude desktop app through Claude Code's inbox, marked as not from you? | Only check C6 runs in 0.25.1; nothing is built |
| 4 | On delivery, setup and launch changes, may the first review round read only the case table and tests? | Not tried in 0.25.1; review stays as it is |
| 5 | macOS has no process lookup here, so board approvals fall back to Claude Code's own prompt there. Accept this for 0.25.1? | Accepted, and the release notes say so |
| 6 | Claude Code does not update a third-party plugin by itself, so a person with only the plugin does 2 steps each release. Accept this bar for 0.25.1? | Accepted. If C5 finds the person can turn on automatic updates, the notes say how |

A later decision, 2026-11-19: 「按照你的建議」 ([#1327](https://github.com/WenyuChiou/agent-board/issues/1327#issuecomment-7024987371)).

| # | Question | Decision |
|---|---|---|
| 7 | Retiring Gemini CLI on upgrade (#1327, #1337) takes out hook lines setup wrote, which R7 keeps out of a patch release. Move it to 0.26.0, or make an exception for 0.25.1? | 0.26.0, where two pull requests replace #1337 |

## 15. How the review findings were answered

| Finding | Answer |
|---|---|
| Codex 1, Opus 6: the hash list rejects a real board and approvals vanish | No hash list; refusal record; both version directions tested (section 4) |
| Codex 2: a cached start time can authorize a wrong wake | Identity recorded together and checked fresh (M5a); that design was dropped after check C1 |
| Codex 3: no listening port is not proof of a dead owner | Proven end of the old owner; resume test (M6) |
| Codex 4: restart ignores pending deliveries | Stored states, drain, nothing dropped, never forced (M3) |
| Codex 5: the token split breaks terminal and receiver callers | Capability table (M8b) |
| Codex 6: card removal depends on C1 | Close detection separated, wording defined (M7) |
| Codex 7: comparing command text misses a changed trigger | Complete declarations compared (gate line 9) |
| Codex 8, Opus note 3: lanes overlap | M4's page work moved to B2; `hooks/blocks.ts` has an owner (section 9) |
| Opus 1: gate lines do not bind | Must-ship list, one issue per line, numbers (section 7) |
| Opus 2: the schedule does not fit | M3 to lane A, lane B split, checkpoints, about 5 weeks (section 9) |
| Opus 3: a day-1 sitting does not meet parity | Two sittings (section 6) |
| Opus 4: the README points at `next` | Candidate on `next`, then promote; both tags agree (section 7) |
| Opus 5: the fix does not reach plugin people | Ceiling 3, plugin walk, exact command in the notes (sections 1, 4, 7) |
| Opus 7: the theme is never walked | C8, real `npx`, a person's open defined (M3, gate line 10) |
| Opus 8: a bad update has no way back | Whole previous install, health check with a real report, stop signal, manual command (M3) |
| Opus 9: the token fix was cut first | M8a is never shipped around (M8, section 10) |
| Opus 10: at-once start makes #1370 common | #1370 in M5a with a test and card wording |
| Opus 11: the merge-first list was wrong | Each pull request has its real need, an owner and a day (section 9) |
| Opus 12: two writer-safety issues had no home | #1488 and #1607 in M1 |
| Opus 13: four claims about issues were wrong | #1304's notice kept; #1092's question answered first; #1296 stays open; rename dropped |
| Final check: six problems in this plan | Records run on the release build; walks before a version number is used; a separate plugin bar; the approval claim narrowed; the whole install restored; the read boundary tested (sections 1, 7, M3, M9) |

## Unconfirmed

- C6 and C7 are open until sitting 1. The plugin step count of C5 and the elevated sandbox and app rows of C8 are finished there too.
- Turning on automatic plugin updates comes from Claude Code's documentation, not a live run (C5).
- Claude Code's turn-start time has not been timed separately from its acknowledgement.
- The day counts and the 5-week date are estimates.
- The count of about 140 issues to move comes from titles and is checked issue by issue when moved.

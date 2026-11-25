# Plan for 0.25.2

**Status:** draft for the owner's approval in its pull request. Not in force until he approves it.

**Superseded (2026-11-24):** there is no separate 0.25.2 release. The owner chose "Mainstream first": the next release makes the mainstream AIs work end to end, and because its routes change hooks (R7) it is 0.26.0. This plan's no-hook part continues there, see [plan-0.26.0.md](plan-0.26.0.md), section 1; the self-update (U1 to U4) moves to 0.27.0.

**Where it comes from:** a Fable 5.2 review of the whole project after 0.25.1, the owner's five decisions of 2026-11-24 ([#209](https://github.com/WenyuChiou/agent-board/issues/209#issuecomment-7140347947)), a draft plan, and two outside reviews of that draft (Claude Opus and Codex Sol, 13 must-fix findings, all held after a check at the tag; see "Changes from draft 1"). Code read at tag `agent-board--v0.25.1` (`8ccb458b`); nothing was run.

**Fixed inputs:** the Top 10 of the Fable 5.2 diagnosis after 0.25.1, in its order, and its Part D (extensions and the roadmap; both kept outside the repository, their findings cited here by file and issue); the owner's five decisions (#209 comment 7140347947). **Reused:** the self-update design of `docs/dev/plan-0.25.1.md` M3. **Words:** *hook change*, *a person's open*, *release build*, *candidate*, *stand-in* as in `plan-0.25.1.md`. *Step*: learning there is something to do, starting it, answering a question, running a trust command, restarting a host, or opening the board again to check (#1313). *Gate item*: one of Top 10 items 1 to 6.

## Changes from draft 1

Each must-fix was checked at the tag before it was taken. All thirteen hold; none is rejected.

| Must-fix | Held? | What I checked | Answered in |
|---|---|---|---|
| Opus 1: the way back has no process running old code | **held** | board commands run `node "<installed path>"` (`hooks/board-commands.ts:5-7`); the launcher runs the installed script (`bin/agent-board.mjs:357`) | M3, U2 (section 4): a kept recovery program, a watcher, staged writes; order U1, U2a, U3, U2b, U4 |
| Opus 2: host hook entries and trust are not restored | **held** | Hermes trust file (`scripts/codex-local.ts:282, 1917`); trust read at update (`:2205-2207`) | U2: the board's entries in host configs and its trust entries are copied; trust read back |
| Opus 3: any agent can compute the digest | **held** | setup's own rule: "an agent's shell tool cannot approve for the person" (`scripts/setup-agent.mjs:22-24`); the question is printed to any caller (`:791-796`) | U4: the yes is a press the server recorded |
| Opus 4, Sol 4: gate lines 9 to 12 bind nothing | **held** | `docs/RELEASING.md:22`; draft 1's 17 issues had none for them | Section 7: three new gate issues; line 12 leaves the gate |
| Opus 5: #1321 misread, F3 dropped | **held** | #1321's body: F3 unticked, "Feeds M6"; its last comment says unnamed checks "stay open here" | K5; section 8 |
| Opus 6: K3 can pass while the fix changes a compared file | **held** | the OpenCode plugin is compared as whole text (`tests/hook-declarations.test.mjs:331`); it passes on four event types only (`hooks/local-agents.ts:307`) | K2 and K3 reworded; H1 |
| Opus 7: question 4's default breaks the checklist | **held** | `PARITY-CHECKLIST.md:107, 109, 111` | Sections 6, 14 |
| Sol 1: a re-tagged use is still asked about | **held** | the question compares versions only (`scripts/setup-agent.mjs:772`) | M2, as #1812 now says |
| Sol 2: the old server can pass the health check | **held** | `/api/ping` is answered by the running process (`scripts/board-serve.ts:954`); `ensureServer` reuses it (`scripts/board-cli.ts:2919`) | U2: the check names the new build |
| Sol 3: no recovery entry survives a broken replacement | **held** | same lines as Opus 1; "no rollback" (`scripts/codex-local.ts:2422`) | U2: recovery program outside the replaced files; a named limit |
| Sol 5: a terminal-only home has no source for the notice | **held** | the terminal board is entered directly (`scripts/board-cli.ts:3342-3343`) | Section 1, U1: the promise is narrowed |
| Sol 6: 47 of 68 is a family count | **held** | diagnosis F2: 47 "name Claude alone as author family" | Section 9 |

Notes taken: #1788 closed; #1689 dropped (it concerns 0.25.0 or older); line numbers from #1769's head are marked; T1 gets a Done-when; the 400-line limit counts new files; lane files; `ready` before start; the sitting's size; #1815; the date.

## 1. Theme, and the bar as numbers
**Theme: the board updates itself and can come back, and what it says is true.** No host gets a faster reply in this release (decision 2).

**The eight moments** (`plan-0.25.1.md` section 1). "Today" is from the diagnosis, A0. The right column is a **target**; it binds only where a gate line names it (lines 5, 6, 8).

| # | Moment | Today, 0.25.1 (measured) | 0.25.2 target |
|---|---|---|---|
| 1 | A new version arrives | No check exists. 0.25.0 to 0.25.1: 1 command and 1 `y` on Linux; 4 steps on the README path on Windows; 3 with the plugin (upgrade walks, 11-24) | 0.25.1 to 0.25.2: **3** (learn, one command, one answer), once the READMEs' update line names that command. From 0.25.2 on, on the page: **0**, or **1 confirm** (line 6). Plugin only: **3** |
| 2 | A reply starts the AI | Claude Code, OpenCode: delivered, seconds not written. Codex CLI: about 14 min, then a wrong card for 12 min (#1796) | Same routes. Codex's card reads replied within 60 s of the ACK (line 8). Seconds: 10 s, 2 s, Codex at most 15 min (**unconfirmed**, K1) |
| 3 | Open sessions are there | A hook event shows in under 0.4 s (Windows), 10 ms (Linux). The list from Codex's records is not built | 2 s holds. The list within 10 s only if #1316 ships |
| 4 | The board opens, or says why | Passes in `tests/e2e/l3c-message-store-ownership.test.mjs`; not timed; one Linux case open (#1727) | Timed in the record: 10 s after a dead page |
| 5 | A card leaves with its window | Linux only. On Windows "The window may be closed." shows on an open window (`hooks/parse.ts:476-486`) | The line never shows on an open idle window at two minutes (#1813, line 8) |
| 6 | An approval is safe | Built (#1678). The rerun with Claude Code's Bash sandbox on is in no record | Runs 2 and 3b rerun and recorded (line 10) |
| 7 | First install | Not counted; 7 at 0.25.0. Windows `[Y/n]` unwalked for four releases | Counted once in the sitting; no cut planned |
| 8 | A bad update returns | Not built | The previous install is back within 60 s of a failed check, with no command typed; one trust step per host at most, when the update had changed a hook (U2, line 6) |

**Person steps per journey.**

| Journey | Today | 0.25.2 target |
|---|---|---|
| J4 open the board | 1 in Claude Code, OpenCode, Hermes, `agy`; Codex CLI, Grok "needs owner" | 1; the sitting fills the two cells |
| J5 answer on the board | Claude Code, OpenCode: 1 press. Codex CLI: 1 press and a wait. Codex app: 1 press and quitting the app. Antigravity: 1 press, next turn. Grok, Hermes: Copy and paste | unchanged (decision 2) |
| J11a, the last release to this one | 4 (Windows, README path); 1 command and 1 `y` (Linux); 3 (plugin) | 3 on each path, learning counted |
| J11b, this release to the next, page | does not exist | 0 with nothing to ask, 1 with something |
| J11b, a home that only uses the terminal board | does not exist | **3, as J11a.** What is wrong: this person gets no notice. Only the page server asks npm (owner, 11-22), and the terminal board starts no page server (`scripts/board-cli.ts:3342`). It shows the line only if a page server on that home checked in the last day. Named in the notes |

**Seconds from Send to turn start.** Claude Code CLI: not written today, target 10 s. OpenCode: not written, 2 s. Codex CLI: about 14 min (parity 0.25.1, note 1), target 15 min. Codex desktop app: after a full quit, lapses at 30 min; unchanged and named in the notes. Antigravity next turn, Grok and Hermes Copy: unchanged. `cursor-agent` 2026.11.22: no card (#1793); the card is back, or the notes name the limit.

## 2. Goals and non-goals
**Goals, the gate (Top 10 items 1 to 6):** G1 the token leaves the chat. G2 the board learns of a new version, updates itself, and returns from a bad one. G3 the update question tells the truth. G4 Codex's card says what happened. G5 a question never goes missing. G6 one owner sitting, early. **Ships if ready (items 7 to 10):** sessions at once (#1316); the bars as numbers (#1313, #1656, #851); the FRICTION fixes; reviews and first-try green.

| Stays out | Where | Why |
|---|---|---|
| Codex at once (#1652), the Antigravity wake (#1612), receivers for Cursor, Grok, Hermes, OpenClaw, the Claude desktop door's receiver | 0.26.0 | each needs a hook added or changed; R7 forbids that in a patch release |
| Codex and OpenCode approval buttons, the six states (#1317), Gemini retirement (#1327), checks F16 to F21 of #1321 | 0.26.0 | hook changes, or hook lines removed |
| Person-only routes (plan-0.25.1 M8b, #1119) | 0.26.0 | no issue of its own; the confirm and the switch use the page secret that exists at the tag (`scripts/board-serve.ts:535-544`) |
| Agent sending (#317, #1776), the MCP route | 0.27.0 | 696 lines outside tests, six rounds, in conflict |
| An update notice for a home that never opens the page | later | needs a check outside the page server, which the owner ruled out on 11-22 |
| Any new reply-on-board route | 0.26.0 | decision 2. **[reply on board] does not move in 0.25.2 for any host** |

## 3. Milestones, in build order
Every milestone: **no hook added, removed or reworded, and no file that `tests/hook-declarations.test.mjs` compares is changed.** That test compares each host's declaration file, and for OpenCode and DeepSeek the whole generated text (`:330-331`). T1, T2 and the U pull requests are risk tier with a case table before code (R6).

### M0. The sitting and five checks (days 1 and 2)
- **Work:** the owner's sitting (section 6). Five half-day checks by lanes, each a dated note in `docs/validation/`:

| Check | Question | Settles | If the answer is no |
|---|---|---|---|
| K1 | Three sends to an idle Codex CLI session: minutes from Send to turn start | moment 2's Codex target | the card and the table take the measured number; no code change |
| K2 | Does `cursor-agent` 2026.11.22 still run the hooks setup wrote, and can #1793 be fixed without changing `~/.cursor/hooks.json`? | #1793 | the fix moves to 0.26.0; the notes name the limit |
| K3 | Can #1795 be fixed without changing the generated OpenCode plugin's text? (It passes on `session.created/status/idle/deleted` only, `hooks/local-agents.ts:307`.) | #1795 | 0.26.0; the notes name the limit. This is the likely answer |
| K4 | Part D's widened C6, the part a lane can do: can the board authenticate to the inbox pipe of a Claude Code CLI session it did not start, on Windows? The note never records the key (R8) | the 0.26.0 receiver | the row reads "cannot, because". The desktop Code tab and VS Code halves are sitting rows |
| K5 | F3 of #1321: is a Codex session open before setup connected after restart and resume, under which id; where does the app keep its threads? | #1316's Ready check (NOT READY, 11-22) | #1316 leaves milestone 17 that day |
- **Done when:** the sitting record and five notes exist. **Covers:** apps, IDEs, Codex CLI, Cursor, OpenCode, Claude Code. **Test:** the parity record's app table. **Issue:** #1657. **Hook:** none.

### M1. The token leaves the chat (days 1 to 4)
- **Work:** #1769 re-cut as T1 then T2 (section 5). #1779 is a row of T2's table.
- **Done when:** #1650's own lines; the parity record's "Left behind" names no model that saw a reusable link.
- **Covers:** every agent with a board command, the DeepSeek tool, the plugin's `/progress open`; page and terminal board. A person with only the plugin gets the plugin's half after updating the plugin; the notes lead with that.
- **Test:** `tests/page-one-use-open.test.mjs`, split by table; `tests/page-open.test.tsx` with exact words. **Issues:** #1650, #1779. **Hook:** none.

### M2. The update question tells the truth (days 1 to 3)
- **Work:** #1812 as the PM rewrote it on 11-24: both uses leave `newUses`, with their words. Neither is re-tagged. U1 adds `version-check` back with its version, switch and test; #1316 does the same for `codex-sessions`.
- **Done when:** #1812's lines. If U1 is cut, 0.25.2 asks about nothing it lacks. **Covers:** every setup agent; setup, the launcher, the page's Settings.
- **Test:** `tests/host-upgrade.test.mjs` (line 1039 pins the words only today); a case that fails when a use has no switch. **Issue:** #1812 (`ready`). **Hook:** none.

### M3. The self-update (days 3 to 14)
What is wrong with it: the board fetches and runs new code from npm with no press. The owner accepted that on 11-11 (「可以，自己升級」). The limits of `plan-0.25.1.md` M3 are kept. **What changes, each from a fact:**

| Change from plan-0.25.1 M3 | Why |
|---|---|
| Only the page server asks npm | Owner, 11-22 (#1315) |
| The new install is written beside the old one and switched in as the last step | Setup has no rollback (`scripts/codex-local.ts:2422`). A killed update then leaves the old install whole (Opus 1) |
| A recovery program from the previous version is kept outside the files being replaced. On the unattended path the old server takes the copy and starts that program as a watcher before it hands over | After the handover no old code runs, and every board command loads the installed script directly (`hooks/board-commands.ts:5-7`). A new script that throws at load reads no marker (Opus 1, Sol 3) |
| The health check asks the **new** process: another process id, the staged build's digest, a report written through the new script, and trust read back for each host the update touched | The old server answers `/api/ping` itself (`scripts/board-serve.ts:954`); a report alone passes with silent, untrusted hooks (Sol 2, Opus 2) |
| The copy holds the board's own entries in each host's config and its own trust entries, not only the board's files | The first unattended update is to 0.26.0, which changes hooks. 0.25.2's code is what restores it (Opus 2) |
| An unattended update removes no file. A restore removes only files the update added and whose bytes are still the update's | #1707; the "bytes still ours" rule of #1488 |
| The automatic start is built last | A release cut before the way back would ship code-fetching with no return |

**What a typed update gets, and what is wrong with it:** a typed `setup --update` runs the new package's setup (`bin/agent-board.mjs:332`), so its copy and its check are new code. A person is watching. It asks a running board of 0.25.2 or later to watch for it; from 0.25.1 there is no such board, so setup checks and restores itself. The rule "restore runs from old code" holds on the unattended path only.

**Limit that stays, named in the notes:** a computer that stops during the switch itself (a few renames) with the watcher dead can be left with a new script that does not load. The way out is one tested manual command that runs the kept recovery program and never loads the broken bundle. A 0.25.2 or later launcher that finds an unfinished switch older than two minutes runs it too.
- **Done when:** Top 10 item 2, plus each issue's lines (section 4). **Covers:** all setup agents; the page. A plugin-written script is never updated through `npx`.
- **Test:** named per issue in section 4. **Issues:** #1315, closed once U1 to U4 exist. **Also changes:** `SECURITY.md:73`. **Hook:** none.
- **Unconfirmed (U-b):** every file setup writes is replaced by a rename. Check: read the writer in `scripts/codex-local.ts`, half a day, before U2a's case table. If not: U2a makes it so. A hook that fires between two renames meets a new script beside old skills: a row of U2a's case table.
- **Unconfirmed (U-c):** the copy's size (the bundle is 2.09 MB). Measured in U2a; limit 10 MB; one copy kept.
- **Unconfirmed (U-e):** that Codex and Hermes accept a restored trust entry (Hermes records `script_mtime_at_approval`, `scripts/codex-local.ts:282`). Check: walk (a) with a real Codex and Hermes, half a day, during U2b. If not: the board names the trust step; moment 8 already allows one.

### M4. Codex's card says what happened (days 1 to 6, parallel)
- **Work:** #1796, #1773 (PR #1811), #1553, #1813, #1814 (claimed by the Gemini lane).
- **Done when:** each issue's own lines. **Covers:** Codex CLI and desktop app, every mailbox host; page, terminal board, `--json`, `docs/MESSAGING.md`.
- **Test:** `tests/messaging.test.mjs`: "an ACK after `OWNER_DISCONNECTED` settles the message as acknowledged"; the stand-in that starts and then emits `'error'`; the `SUSPECT_CELLS` of `hooks/delivery-states.ts` turned back on. `tests/e2e/l4-time.test.mjs`: an open idle window at two minutes. The route-copy pin test.
- **Order:** #1553 merges before U3, which reads the same stored states. **Hook:** none.

### M5. A question never goes missing (days 2 to 8, parallel)
- **Work:** #1793 and #1795 after K2 and K3. **H1, new:** the board script, when a hook runs it, appends "host, event, time, result" to a bounded file; the doctor prints each host's last run and its age. H1 changes no file the declaration test compares: the line is written by the installed board script, not by a host's hook file or plugin. **H2, new:** one live row per installed CLI, weekly, in the kept test home.
- **Done when:** `cursor-agent` gives a row and a card, and an OpenCode dialog question shows as waiting, or K2 or K3 moved that fix; after one event per installed CLI the doctor names each host's last run, and "never ran here" for a silent one; the newest weekly record is at most 7 days old at the tag.
- **Covers:** Cursor, OpenCode; every hook host; the doctor. **Test:** a reader case per host; a hook-reporter case per shell and a size-bound case; the weekly record. **Hook:** none for H1 and H2; #1793 and #1795 by K2 and K3.
- **Unconfirmed (U-d):** H1's cost. Check before merge, on Windows: 100 hook runs with and without. Limit 10 ms added at the median; over it, the line is written only on a failure and on a host's first run of the hour. The same run gives the hook's total time on the 2.09 MB bundle, the number diagnosis A5 asked for before update code joins it.

### M6. Ships if ready (from day 5), in this order
1. The record's table of the eight moments (decision 1 puts it here, not in the gate).
2. Seconds per host and a budget in each stand-in route test (#1656); the step ledger (#1313, #851).
3. #1805, #1806, and #1803 and #1809 once their change requests are answered; #1642.
4. First-try green: the sampler logs read (#1249); #1768; #1786 and #1804 after their Ready checks (no raised limit, retry or skip, R6); #1808, #1810, #1746; `tests/codex-local.test.mjs` split by subject (Top 10 item 10).
5. Sessions at once (#1316), after K5.
6. #1244, #1245, #1283 from 0.26.0, lane R (no hook by title; **unconfirmed**, a Ready check each).
7. #1727, only with a row that a restore to 0.25.1 still starts.

### M7. Rules and the plan (day 1)
No code. Rules pull request #1815 (decision 5) is open and waits for the owner's hand (R6). This plan lands as `docs/dev/plan-0.25.2.md`, as #1655 did.

## 4. The #1315 split
**Why #1650 comes first.** What is wrong with the claim: it is not a code dependency; the page secret exists at the tag. What holds: (1) #1769 changes `scripts/board-serve.ts` (+152), `scripts/board-cli.ts` (+183), `hooks/serve.ts` (+46) and three bundle parts, the files every U issue changes; (2) T1 changes what a page session is, and U4's confirm binds to it; (3) the reviewed plan never ships the confirm around the token fix (`plan-0.25.1.md` section 10).

**Order: U1, U2a, U3, U2b, U4.** U2 is one issue and two pull requests, because R6's 400-line limit counts new files. Each merge leaves a safe release: U3's restart is called by nothing until U2b wires it in.

| Issue | Title | Done when | Test | Waits on |
|---|---|---|---|---|
| **U1** | The page server asks npm once a day, and the page shows one line with the command | One request per 24 hours across page servers started at once; the result is kept in a file the terminal board also reads. Switch off: the stub registry gets no request. A dead registry costs under 2 s and never delays the page. A `latest` lower than the installed version is a stop. The pull request adds `version-check` to `newUses` with 0.25.2, the "Check for new versions" switch (pressed with the page secret) and the consent test | `tests/npm-package.test.mjs`: one a day, off means none, dead endpoint, lower `latest`. `tests/host-upgrade.test.mjs`: "a 0.25.1 home is asked once about the daily check"; "a home that only ran the terminal board shows no line and makes no request" | #1812, T1, the sitting (first pull request) |
| **U2** | A bad update returns | **U2a:** the update is written beside the old install and switched in last; a copy of what the switch replaces is kept, with the board's entries in each host config and its trust entries; a recovery program from the running version sits outside those files; one manual command runs it. **U2b:** before handing over, the server starts that program as a watcher. The check is M3's four parts. On a failure within 60 s, the watcher restores the copy, keeps files the person edited since, starts the old board, names any host that needs a trust step, and records the version as not to retry | U2a, `tests/host-upgrade.test.mjs`: "an update killed before the switch leaves the old install whole"; "an update killed after the board script was replaced is recovered by the manual command without loading the new script"; "a restore keeps an edited file and removes only files the update added". U2b: "a new version whose board script throws when loaded is replaced by the previous install within 60 s, with no command typed"; "an old healthy server and a broken replacement: the update is not marked healthy"; "a restore after a changed Codex and Hermes hook reads trust back"; "that version is not retried" | U1; U-b. U2b: U3 |
| **U3** | The board can hand over to new code and keep every message | Readiness from the stored delivery states, not `isBusySending()` (`scripts/board-serve.ts:630`). While draining, a new send is refused in words. A queued message, a claim, a pending ACK and an approval watch survive. The old server is proven ended before the new one takes the store (#1671). A board that cannot drain stays on its code and says "restart the board to finish". Nothing calls the handover for a person until U2b | `tests/messaging.test.mjs`: the restart case with those four. `tests/e2e/l3c-message-store-ownership.test.mjs`: old to new handover | U2a, #1553 |
| **U4** | A person's open of the page starts the update; one confirm when something must be asked | With a stub registry and a locally built higher version, a visible page holding the page secret (`scripts/board-serve.ts:373, 414-416`) updates the home with no command typed, from Codex CLI and from Claude Code on Windows. With something to ask, the page shows setup's question. Setup takes a yes with no terminal only by asking the running server, which confirms a question's digest only if a page holding the page secret pressed it in the last 30 s, and only once. `--json`, `--status`, `--report`, hooks, a page not in sight and the network page never start one. No `npx`, or a blocked request: the line and the command. The "different build" line stays silent for an updater-installed version | `tests/host-upgrade.test.mjs` J11b: 0 steps; 1 step; "setup --update run by an agent with the right digest and no page press writes nothing and approves no hook"; "a pressed yes is used once". `tests/npm-package.test.mjs`: "an agent's plain board command does not start an update" | U2b, T2, #1809 (same launcher path) |

## 5. The #1769 re-cut
What is wrong with it: #1769's body says `Size: cannot split`, because a part alone "would either say 'opened' with no proof or leave an entry point with no usable link". That holds for a split by entry point. Server first, commands second avoids it only if T1 changes no command's output, and **I did not read #1769's diff**, so that is T1's first Done-when line, with a test. Line numbers below are at #1769's head `9d08d74f`, not the tag.

| PR | Surface | Holds | Done when | codex_689's findings it answers (7119502364) |
|---|---|---|---|---|
| **T1, first** | `data` | The server's one-use link (`/api/open-link`, `/open/<code>`), the page session, the session-lost screen: `scripts/board-serve.ts`, `hooks/serve.ts`. About 224 changed lines in #1769's list | "every entry point prints at T1's head what it printed before" (one pinned-output test per entry point); a used link is refused; the cap rows | `board-serve.ts:581-582`: at the cap a new mint is refused (`serveBusy`) instead of pushing out a live code, and used codes sit in their own bounded list. `hooks/serve.ts:1461`: a dead link ends the tab's session at the server |
| **T2, second** | `launch` | What each entry point prints: `openBoard` in `scripts/board-cli.ts`, `hooks/live-page.ts`, `hooks/register.tsx`, `hooks/portable-agents.ts`, strings. About 323 lines | #1650's lines; #1779's row | `hooks/live-page.ts:75`: the `ssh -L` note reaches the plugin's reply. `tests/page-open.test.tsx:76`: exact words. `scripts/board-cli.ts:3028`: "already open" only with proof |

- If the pinned-output test cannot pass, the split fails: the fallback is one pull request with the owner's hand approval, which decision 4 set aside, so it goes back to him.
- The cap rule is a proposal for T1's case table. Line counts are before the five fixes.
- **A Claude lane does the re-cut.** #1769's authors are Gemini and Claude, so the reviewer is of the GPT family (R2). A Codex lane writing it would leave only Muse or the owner to review.
- R6 counts rounds per pull request, so T1 and T2 each start at zero; each body links #1769's five counted rounds and its last review.
- Carried: the failed `pr-check` and the unanswered Greptile finding on `9d08d74f`. #1769 closes once both are open.

## 6. The owner's sitting
**When:** day 1 or 2, on released 0.25.1. **Rows, as #1657 lists them:** (1) the 48 app and IDE cells of the 0.25.1 parity record; (2) Windows `[Y/n]` setup in a real terminal (C7), steps counted; (3) Codex CLI checks a and e, Grok Build check a; (4) C6 in the desktop Code tab and VS Code; (5) the Antigravity desktop app keeps its page (#1674); (6) display scaling and the profile folder's size for the docked page (#1084); (7) a real SSH run of the bare command (#810). **Not in #1657 yet:** C8's elevated sandbox and Codex app rows (owner, 11-22, on #1315).

- What is wrong with it: this is more than decision 3's "app and IDE rows" and will not fit two hours (last round's review said so with fewer rows). Row 1 goes first; rows 2 to 7 and C8 continue the next day, and nothing is skipped.
- **Blocks:** the first pull request of the plan's new work (U1 to U4, H1, H2, #1316). Writing that code is not blocked (decision 3).
- **Does not block:** fixes for bugs already filed, the #1650 re-cut, the pull requests in review, K1 to K5.
- **If it has not happened by day 3:** the notes say apps are untested, #865 and #868 leave the milestone, gate issue #1657 goes to the owner, and U1's pull request opens anyway on day 4 with that written in its body.
- **It does not meet the parity gate, and draft 1's default was wrong.** `PARITY-CHECKLIST.md:109`: a change to `bin/agent-board.mjs` means a full run; `:107`: `scripts/board-serve.ts` reaches checks c and e on every installed row; `:111`: every `needs owner` cell is always in; `:86`: app rows run on the release. So a stable 0.25.2 needs a full app run on the release build: about two more hours, days 13 to 14. Question 4. #1657's Done-when is rewritten to the answer.

## 7. The release gate, as lines
Only lines 1 to 4 decide stable (R7; `docs/RELEASING.md:22`). Every other line binds through a must-ship issue that line 4 counts. **Milestone 17's description names no must-ship issue today**; the plan pull request writes section 8's 20 gate issues into it. Each line is run by someone who did not write that milestone, and the record names them.

1. CI is green on Ubuntu and Windows on the tagged commit.
2. The parity record for 0.25.2 exists, as question 4 is answered; every FAIL names an open issue outside the must-ship set.
3. The L1 to L3 journeys and the upgrade journeys pass, J11b among them.
4. Every must-ship issue is closed.
5. **Token (#1650):** no stdout line holds a reusable link on open, failed open, SSH or `--no-open`.
6. **Self-update (U2, U4):** on the release build with a local registry and a higher version **that changes one Codex hook command and one Hermes hook**, a real `npx` on Windows from Codex CLI and from Claude Code updates the home with 1 confirm; with a version that changes nothing to ask, 0 steps; a new version whose script throws returns within 60 s with trust read back; switch off, no request. Walks: (a) a 0.25.1 home with a real Codex and Hermes; (b) plugin only; (c) plugin and npm in one home.
7. **Sitting (#1657).**
8. **#1812:** a 0.25.1 home is asked once, only about what 0.25.2 has. **M4:** its five tests, and the card within 60 s of the ACK. **M5:** the doctor's last-run line per installed CLI; a weekly record at most 7 days old.
9. **Hook declarations (new issue N1):** the test's baseline is 0.25.1 and it passes on the release head. CI runs it, so line 1 enforces it; N1 closes on the moved baseline.
10. **F10 rerun (new issue N2):** runs 2 and 3b, Claude Code's Bash sandbox on, in a dated note. The owner moved it here on 11-23 (milestone 17's description).
11. **First try (new issue N3, as #1660):** the tagged commit is green on its first attempt; opening an issue does not close N3.

**Out of the gate:** the eight-moments table (M6 item 1). **To the owner through the plan pull request:** N1 to N3 add three must-ship issues beyond decision 1's six items.

**Published as in `plan-0.25.1.md` section 7.** **What the last release skipped:** gate lines 5 to 8 and 12; walks (c), (d), (e); sitting 2; J11b; the route suffix on 14 verdicts; outside reads done as 31 in one night. **Nobody can receive 0.25.2 by itself**, so the first unattended update is to 0.26.0, a hook release. Line 6 is the only rehearsal, which is why its test version changes hooks.

## 8. Milestone 17 as it stands: 38 open issues (`gh`, 11-24, after #1788 closed)
Proposals only. Gate = the must-ship set: 20 issues once U1 to U4, H1, H2 and N1 to N3 exist and #1315 closes.

| Issue | About | Proposal |
|---|---|---|
| #1650, #1779 | token | **gate** (M1) |
| #1315 | self-update | **gate**, as U1 to U4; closes when they are open |
| #1812 | update question | **gate** (M2); `ready` |
| #1796, #1773, #1553, #1813, #1814 | Codex's card | **gate** (M4). #1796, #1553, #1813 are `ready`; #1811 fixes #1773; #1814 is claimed |
| #1793, #1795 | a missing question | **gate** (M5); each moves to 0.26.0 on K2's or K3's note. #1795 is likely to |
| #1657 | the sitting | **gate**; new Done-when after question 4 |
| new: U1 to U4, H1, H2, N1, N2, N3 | | open after the plan merges; **gate** |
| #1656, #1313, #851 | the bars as numbers | ships if ready; #1313 and #851 need new bodies (Ready checks, 11-22) |
| #1798 to #1802, #1789 | usersim fixes | in; #1805 and #1806 in review; #1809 back with its author |
| #1752, #1720 | type error; CI budget check | in; #1803 back with its author |
| #1642 | sidecar question | in; claimed by Muse |
| #1768, #1808, #1810, #1804, #1786, #1746 | flaky tests | ships if ready; #1808 and #1810 `ready`; #1786 and #1804 await a Ready check |
| #1249 | runner sampler | **close** with the reading of three logs |
| #1316 | sessions at once | ships if ready, after K5; out on day 2 if K5 fails |
| #1727 | a page nobody reaps | last, first to cut; `ready` held until U3 merges (PM). Its claim-format change is one "older boards read as a damaged claim", so a restore to 0.25.1 could leave a board that cannot start |
| #1507 | a claimed Codex message | **close**, with a narrow Backlog issue for the 19.8 s stall (two of three points met by #1682; the A or B question is unanswered) |
| #1321 | checks F1 to F21 | **move to 0.26.0**, not closed: 15 checks are unticked and F16 to F21 feed 0.26.0. F4 and F5 become sitting rows; F3 is K5 |
| #810 | README and SSH | **close** after sitting row 7 |
| #865, #868 | `/agent-board` everywhere | stay; close with the sitting record |

**Not pulled in:** #1689 (it concerns a setup of 0.25.0 or older; a restore copies files and runs no older setup). #1707 is avoided, not fixed. #1790 stays in 0.26.0: an install in other folders gets the line and the command.

## 9. Who does what in parallel
A lane claims by assigning itself, and starts an issue once it is `ready` (R4). This table sets no person.

| Lane | Work | Files |
|---|---|---|
| S, the spine (serial) | T1, T2, #1812, U1, U2a, U3, U2b, U4 | `scripts/board-serve.ts`, `scripts/board-cli.ts`, `hooks/serve.ts`, `hooks/live-page.ts`, `hooks/register.tsx`, `hooks/portable-agents.ts`, `hooks/page-settings.ts`, `bin/agent-board.mjs`, `scripts/setup-agent.mjs`, `scripts/setup-discovery.mjs`, the writer in `scripts/codex-local.ts`, new update files, `tests/page-one-use-open.test.mjs`, `tests/npm-package.test.mjs`, `tests/host-upgrade.test.mjs`, `SECURITY.md` |
| D, delivery | #1796, #1773, #1553 | `hooks/messaging.ts`, `hooks/delivery-states.ts`, `scripts/background-resume.ts`, `scripts/codex-receiver.mjs`, `tests/messaging.test.mjs` |
| C, words | #1813, #1814 | `hooks/parse.ts`, `hooks/receiver-routes.ts`, `hooks/receiver-record.ts`, `docs/MESSAGING.md`, `tests/e2e/l4-time.test.mjs` |
| H, hosts | K2, K3, #1793, #1795, H1, H2 | `hooks/inbox.ts`, the hook-event and doctor paths in `scripts/codex-local.ts`, `docs/validation/` |
| R, records and CI | the sitting record, K1, K4, K5, N2, #1656, #1313, #851, #1249, the flaky tests, M6 item 6 | `docs/validation/`, test files, `.github/workflows/` (owner's approval) |

- **Shared, so ordered:** the string tables and the bundle merge one at a time. `scripts/codex-local.ts` is in lanes H and S: H1 merges before U2a opens. `tests/messaging.test.mjs`: #1553 before U3. `bin/agent-board.mjs`: #1809 before U4.
- **The Antigravity lane** works from issues with complete bodies and `for-agent`: #1813 and #1812 today.
- **The spine should not sit with the maintainer.** Evidence: the maintainer took over #1314, #1769 and #1612 itself, and 31 of 68 pull requests merged on the maintainer route, so reviews and the release waited on one session (diagnosis F2). The diagnosis's "47 of 68" counts pull requests that name Claude alone as author family, across lanes; it is not the maintainer's count.
- **Safe to start before the plan merges, each once `ready`:** #1812, #1813, #1796, #1553, #1808, #1810 (`ready` now); #1773 (#1811), #1814 (claimed), #1642, #1768, #1746, #1249's reading; #1786 and #1804 after their checks; K1 to K5; the #1650 re-cut once its split is named on #1769.
- **Not before the plan merges:** U1 to U4, H1, H2, N1 to N3, #1316, #1727.

**Days, an estimate, lane S in series.** T1 days 1 to 3; T2 3 to 5; U1 5 to 6; U2a 6 to 8; U3 8 to 10; U2b 10 to 12; U4 12 to 14; records, the full app run, walks, candidate and promote 14 to 17. What is wrong with it: that is seven risk pull requests in a row with no slack. Last release's two spine pull requests were open 7.4 and 26.5 hours and took 6 and 7 change requests; at the measured 4.0 a case-table pull request, seven is about 28 rounds. #1815 may lower that; nothing measures by how much. Four steps wait on the owner's hand: the plan, #1815, the sitting, the full app run. **So the honest date is about three weeks, not decision 1's two.** Checkpoints: day 5, T1 and T2 merged, or the owner gets a new date that day; day 10, U2a and U3 merged, or question 5 goes to him that day.

## 10. If it runs late
**The cut list holds nothing on the critical path; the date is the only lever.** T1, T2 and U1 to U4 are never cut by the team, and question 5 holds the release for U4. Cut order for the rest, first to last: #1727; M6 item 6; #1316; the ledger and #851; flaky tests without a named cause; #1656's budgets. #1793 or #1795 moves only on K2's or K3's note.

**Never cut, never shipped around:**
- T1 and T2 before U4. U2 and U3 whenever U4 ships; U4 never ships alone.
- #1812; #1773 and #1553 (a message run or handed out twice is P0 or P1 by the repository's review rule).
- N1, N3, and the real `npx` walk of line 6 with a hook-changing version.

## 11. Alternatives considered
| Alternative | Why not |
|---|---|
| The owner approves #1769 by hand | Decision 4. 2,637 added lines in 30 files, five P1 open on its last head |
| Split #1769 by entry point | Each part leaves a command printing the old token |
| Push out the oldest code at the cap (#1769's rule) | Two P1 at that rule (`board-serve.ts:581-582` at `9d08d74f`) |
| U1, U3, U2, U4 (the Opus review's order) | U3 alone would restart a typed update onto new code with no way back. U2a first, and U3 unwired until U2b, keeps every merge safe |
| The new version reads a marker and restores | The case that needs it is the new script not loading |
| Health check: the page answers and a report arrives | The old server answers; hooks can be silent |
| A digest of the question as the yes | Any agent can compute it; setup's own rule forbids an agent approving |
| Copy only the board's files | 0.26.0 changes host hook entries and trust |
| Let the terminal board ask npm, so SSH people are told | Owner, 11-22: the page server only |
| An "Update" button, no automatic start | A step every release; the owner chose the automatic start |
| Our own signature on the package | No key to manage before 1.0; exact version, npm's integrity check, and `SECURITY.md` says what runs |
| The weekly live row in CI | It needs signed-in agents in CI |

## 12. Files to change
| File | Change | For |
|---|---|---|
| `scripts/board-serve.ts`, `hooks/serve.ts` | One-use link, page session, session-lost screen; the daily check, the line, the recorded press, the drain, the build identity in the ping | T1, U1 to U4 |
| `scripts/board-cli.ts`, `hooks/live-page.ts`, `hooks/register.tsx`, `hooks/portable-agents.ts` | What each entry point prints; the terminal board reads the check's result file | T2, U1 |
| New files under `scripts/`: the check, the staged write and copy, the recovery program, the handover | They count toward R6's 400 lines, hence U2a and U2b | U1 to U3 |
| `bin/agent-board.mjs` | The "different build" line silent for an updater-installed version (`:342`); an unfinished switch runs the recovery program | U2a, U4 |
| `scripts/setup-discovery.mjs`, `scripts/setup-agent.mjs`, `hooks/page-settings.ts` | Both uses out, `version-check` back with U1; staged writes; a yes only from the server; no removals unattended; the switch | #1812, U1, U2a, U4 |
| `scripts/codex-local.ts` | Writes by rename; the copy of host entries and trust; the trace line; the doctor's last-run line | U2a, H1 |
| `hooks/messaging.ts`, `hooks/delivery-states.ts`, `scripts/background-resume.ts`, `scripts/codex-receiver.mjs` | Late ACK, receipt conflict, `started` on error | M4 |
| `hooks/parse.ts`, `hooks/receiver-routes.ts`, `hooks/receiver-record.ts`, `docs/MESSAGING.md` | The may-be-closed rule; "after about 10 minutes"; Claude's live record | #1813, #1814 |
| `hooks/inbox.ts` | The fixes K2 and K3 allow | M5 |
| The three string tables; `hooks/board-script*.ts` (generated, never edited) | Every new or changed line, in all three languages | all |
| `SECURITY.md`, `docs/RELEASING.md`, READMEs, `CHANGELOG.md` | What runs, when, the off switch, the manual way back and its limit; one update command; the limits for the Codex app, terminal-only homes and plugin-only people | release |
| `tests/hook-declarations.test.mjs` and the tests each milestone names | Baseline 0.25.1 | gate |
| `docs/validation/`; `docs/dev/plan-0.25.2.md`; #1815's files | Records, K1 to K5, N2's note, weekly rows; this plan; decision 5's rules | M0, M5 to M7 |
| **Not changed:** `hooks/hooks.json`, `hooks/local-agents.ts`'s declarations and generated plugin text | R7 | |

## 13. Roadmap past 0.25.2 (Part D, section 4), for #209
| Version | Theme | Proof it is done |
|---|---|---|
| 0.25.2 | The rest of the self-update | Top 10 items 1 to 6 |
| 0.26.0 | Every hook change, the first release that arrives by itself: receivers and Codex at once, the Antigravity wake, the Claude desktop door, Codex and OpenCode approvals, six states with the ask mode and last steps, the notice that opens its card, hook health on the row | seconds from Send to turn start, per host |
| 0.27.0 | Agents use the board: an agent sends (#317), one MCP route, hand-off, the same-folder line; the bridge checks, bot by bot | an agent's message starts another vendor's turn, labelled |
| 0.28.0 | Shared rows leave the computer, to a folder the person already syncs | the file's bytes hold only shared, redacted rows |
| 0.29.0 | Bots write back, never approving | a bot's hand-off starts a local turn |
| 0.30.0 | Away from the desk: the phone sends and answers; the server starts at login | a paired phone starts a turn |
| 1.0.0 | A promise: frozen shapes, every listed host live each release, macOS, the two bars as gate numbers | the gate itself |
| 1.1 to 1.x | The communication panel: several bots and local agents in one thread | a three-party thread with receipts |
| 2.0 | A published shape: a new agent or bot joins by a descriptor file | an outside host connects without our code |
| 2.x | More than one person | two boards, one shared view, no approval crossing |

## 14. Owner decisions still open
| # | Question | The plan assumes, until answered |
|---|---|---|
| 1 | After 0.27.0: the cloud-bot bridge before the phone (Part D), or the phone first as decided on 11-18? | Nothing in 0.25.2 depends on it; the table above is Part D's proposal |
| 2 | May 0.26.0 shrink to hook work only, with agent sending and the MCP route in 0.27.0? | Yes for this plan's non-goals; #1776 is not picked up |
| 3 | Standing allow rules: "after 1.0" or "never"? | "After 1.0" stands; nothing is built |
| 4 | The parity checklist requires a full app run on the release build, because U4 changes `bin/agent-board.mjs`. A second sitting of about two hours near the end, a written change to the checklist, or 0.25.2 as a pre-release? | **A full app run on the release build**, days 13 to 14, on top of the early sitting. Without it and without a checklist change, 0.25.2 goes out as a pre-release |
| 5 | The honest date is about three weeks. If U4 is not merged when the rest of the gate is: hold 0.25.2, or ship the check, the line, the way back and the handover, and name the automatic start for 0.26.0? | **Hold.** Gate item 2 is the owner's, and this would be the third release whose title did not ship. Asked on day 10 at the latest |

## Unconfirmed
- **K1:** the Codex target of 15 minutes rests on one sample of 14. **K2, K3:** whether #1793 and #1795 can be fixed without a compared file changing; #1795 probably cannot.
- **U-b, U-c, U-d, U-e:** writes by rename; the copy's size; the trace line's cost; whether a restored trust entry is accepted. Each has its check and fallback where it is named.
- **T1 changes no command's output:** #1769's diff was not read. The pinned-output test decides, with a fallback in section 5.
- **The residual window** in M3 (the computer stops during the switch with the watcher dead) is not closed, only given a manual way out.
- **By title only:** that #1244, #1245 and #1283 need no hook. The T1 and T2 line counts are from #1769's file list.
- **The date** is an estimate; how much #1815 shortens reviews is unmeasured.
- **Not read:** `hooks/serve.ts`, the message store and `scripts/board-serve.ts` end to end, so U3's handover rests on #1671's rule as described, not on my reading; `docs/dev/team-process.md`; the diffs of #1769, #1803, #1805, #1806, #1809, #1811, #1815; test bodies. Whether the terminal board ever starts a page server was read at two call sites only.

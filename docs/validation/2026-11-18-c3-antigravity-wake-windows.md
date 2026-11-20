# C3: can both timing windows of the Antigravity wake be closed with no hook change?

**Date:** 2026-11-18
**Plan:** `docs/dev/plan-0.25.1.md`, check C3 in M0, feeding M5b
**Verdict: FAIL.** Neither window can be fully closed with no hook change. Reasoning from these results, a hook change would not close them either, so RULES R7 is not what stands in the way.

## The answer in short

- **Window 1, the turn-start hook that never ran:** one part closes with a script change (a hook that starts but is too slow). The part where no hook process runs at all does not close from the hooks. One possible signal from the app is unproven.
- **Window 2, the board's yes to `send-message` landing:** it cannot be closed from our side. The check and the send are two separate steps, and the app offers no "send only if idle". A re-read just before the send covers about 0.1 ms of a window measured at 250 to 540 ms.
- **Nothing found needs a hook declaration to change.** Every script fix tested left the generated declarations byte-identical. The worker and sidecar edits in that test were placeholder comments and only the gate edit changed logic; the generator does not embed those bodies, so the result holds.

"Closed" here means no order of events lets the fixed wake line land in a running turn. "Narrowed" means that order is still possible, but less often or for less time.

## The two windows, from the issue

The owner's decision on #1396 (comment 6932779368) names them:

> a turn-start hook that never ran (the board's hooks have a 3 s timeout);

> the 0.25–0.54 s between the board's `wake-attempt` answer and `send-message` landing, when a person starts a turn in it.

The live run on #1612 (comment 6932556611) is the source of both, and it found why they matter:

> **`send-message` into a running turn injects**

The same decision proposes the fix to try: "check whether the conversation is running right before `send-message` (for example `agentapi get-conversation-metadata`, not verified yet)".

## What counts as a hook change

The plan (line 10) and RULES R7 (`docs/dev/RULES.md:94`) forbid adding, removing or rewording a hook in a patch release. A script a hook already runs may change while its command text stays the same. For this check, a hook declaration is the events, matchers, timeouts, commands and groups generated from `hooks/local-agents.ts` and `hooks/hooks.json`.

One trap: part of `hooks/hook-safety.ts` is inside the declared command. `hookBootstrap` (`hooks/hook-safety.ts:90`) embeds `hookLogSource` (`:55`) in the command text, `HOOK_VERSION` (`:5`) is a command argument (`hooks/local-agents.ts:79`), and the 3 s timeout is at `:23`. Only the body of `hookWorker` (`:173`) is free to change.

## Versions

| Item | Version |
|---|---|
| Repository | main `a679f24f` |
| Draft PR #1612 | head `542ba11c` (merge base `c657eb7d`) |
| Operating system | Windows 11 Home 10.0.26300 |
| Node | 24.14.0 |
| gh | 2.83.1, read-only calls |
| Antigravity desktop app | program files of 2.32.1, read as files only; the app was not started |

The board's half of the wake exists only on the PR (`hooks/antigravity-sidecar.ts` is byte-equal on main and on the PR), so lines cited as "PR head" are at `542ba11c`. All other lines are at main `a679f24f`.

## Results

### Declarations do not change

| Comparison | Result |
|---|---|
| `git diff a679f24f 542ba11c` on `hooks/local-agents.ts`, `hooks/hooks.json`, `hooks/hook-safety.ts` | empty |
| `hooks.json` that setup generated from main and from PR head, into the same folder | byte-identical, 17,267 bytes, SHA-256 starts `581020bd` |
| Installed hook worker, main and PR head | identical |

I then ran the declaration generator with one source edit at a time, and hashed its output for Windows direct, Windows PowerShell and POSIX commands, plus `hooks/hooks.json`:

| Edit | Hash of the declarations | Declaration changed? |
|---|---|---|
| None (baseline) | `8fb45988a35f` | n/a |
| `hookWorker` body | `8fb45988a35f` | No |
| Sidecar script body | `8fb45988a35f` | No |
| Wake gate in `hooks/hook-messages.ts` | `8fb45988a35f` | No |
| Control: timeout 3 s to 5 s | `3e0c03aad280` | Yes |
| Control: `hookBootstrap` text | `817f6feb3bab` | Yes |
| Control: `hookLogSource` text | `5d95efe21260` | Yes |
| Control: one more event | `b40d02256c50` | Yes |

The four controls show the comparison can see a real change.

### Window 1: the turn-start hook that never ran

Each case used the real board and the hook commands setup installed, from PR head. A stand-in played the app. Turn 1 ran and stopped, a board message was queued on the `now` route 10.5 s later, turn 2 then started and did not stop, and the gate was asked for a wake as the sidecar asks it.

| Case | Hook time | Turn order before, then after (started/stopped) | Wake handed out into the running turn? |
|---|---|---|---|
| E. Healthy hook (control) | 189 ms | 1/1, then 2/1 | No |
| A. Board script delayed 2.6 s, code as on PR head | 2,069 ms, exit 0 | 1/1, then 1/1 | **Yes**, and `wake-attempt` answered ok |
| B. Same delay, hook worker writes the mark first (stand-in patch) | 2,071 ms, exit 0 | 2/2, then 3/2 | No |
| C. Hook never launched, code as on PR head | none | 1/1, then 1/1 | **Yes**, and `wake-attempt` answered ok |
| D. Hook never launched, with the stand-in patch | none | 2/2, then 2/2 | **Yes**, and `wake-attempt` answered ok |

Why case A happens: the worker gives the board script until 2 s after the hook started (`hooks/hook-safety.ts:208`), stops it there and queues the event (`:281`). The turn's mark is written inside the board script (PR head `scripts/codex-local.ts:1151`), and a replayed event writes no mark (PR head `scripts/codex-local.ts:1144`).

Even a healthy hook leaves a short blind time. From starting the hook's command to the mark in the turn order file, 30 runs each:

| Where the mark is written | Min | Median | 90th percentile | Max |
|---|---|---|---|---|
| Board script (PR head) | 139 ms | 157 ms | 164 ms | 203 ms |
| Hook worker (stand-in patch) | 58 ms | 64 ms | 83 ms | 94 ms |

These times start when the hook's command starts. The app's own delay before it launches the hook was not measured, so the real blind time is longer.

| Part of window 1 | Closes with no hook change? |
|---|---|
| The hook starts but is too slow | **Yes.** Case B shows it. A hook the app kills before the worker has read its input would still leave no mark (inference, not run) |
| No hook process runs | **No, not from the hooks.** Case D shows it. See "A possible signal" below |
| The normal start-up time of a healthy hook | **No, narrowed only**, from a median of 157 ms to 64 ms |

### Window 2: the board's yes to `send-message` landing

The sidecar asks the board, then runs `agentapi` (`hooks/antigravity-sidecar.ts:136`, `:138`, `:117`). I timed a copy of the real sidecar over 20 wakes:

| Step | Min | Median | Max |
|---|---|---|---|
| Sidecar has the board's yes, to the call that starts `agentapi` | 0.10 ms | 0.10 ms | 0.14 ms |
| One more round trip to the board (what a re-read would cost) | 0.43 ms | 0.56 ms | 1.17 ms |

The live run measured the whole window at 250 and 540 ms. Comparing the two runs (an inference, since they are different runs), over 99% of the window comes after `agentapi` has been started. No script of ours runs at that point, so a re-read before the send cannot reach it.

I also forced the bad order, once, with the real sidecar, board and hook, and a stand-in `agentapi` that ran the real turn-start hook before it counted the line as landed:

| Observation | Result |
|---|---|
| `send-message` calls | 1 |
| Turn order when the line landed | started 2, stopped 1, so the turn was running |
| Board message handed to that turn by its hook | Yes, exactly once |
| Message status afterwards | `accepted` |
| Wakes on the next poll | 0 |
| Next hook carries the message again | No |

So with hooks working, this order loses nothing and sends nothing twice. What is left is one fixed line inside a turn the person has just started. The run did not test the line landing before the hook finishes. How the real model treats the line was not tested here.

The hook-less case is worse. In the live run, with no message attached, the model "wrote an ACK line with a made-up nonce that matches no message" (comment 6932556611, item 2).

### What the app offers

The proposed check cannot work as written. Two live runs on #1396 (comments 6857442163 and 6858335550) already recorded that `get-conversation-metadata` has no running or idle field. A static read of the 2.32.1 program file `language_server.exe` agrees:

- `agentapi` has exactly three command handlers: `send-message`, `new-conversation` and `get-conversation-metadata`.
- The metadata response has three fields: `metadata`, `num_steps` and `trajectory_id`. None is a run status.
- The app does keep a run status internally (`CascadeRunStatus`). As far as the static read shows, it is only on the app's private language-server interface. The sidecar's contract is that it "reads no Antigravity port or token" (`hooks/antigravity-sidecar.ts:22`).

**A possible signal, unproven.** `num_steps` might show that a conversation moved after its last `Stop`, which could catch a turn whose hook never ran. Three things are unknown: whether `agentapi get-conversation-metadata` prints it, whether it rises as soon as a turn starts, and how long the call takes. Even if all three go well, it narrows window 1 and leaves window 2 as it is. The transcript is a weaker candidate, because a turn's own input "may be written after the hand-over" (`scripts/antigravity-meta.ts:341`).

### Would a hook change help?

No (reasoned from the results above, not run against the app):

- A longer timeout helps only the slow hook, which already closes without one.
- A new hook event still runs after the app has started the turn, so the blind time stays.
- Window 2 happens outside every hook. Nothing a hook declares runs between the board's yes and the line landing.

Only the app can close these: `send-message` that queues or refuses during a running turn, or a public "send if idle".

### Files a fix would change

| Fix | Files | Changes a declaration? | Effect |
|---|---|---|---|
| Write the turn mark in the hook worker | `hooks/hook-safety.ts` (`hookWorker` body only), `scripts/codex-local.ts`, `scripts/board-messaging.ts` (both as on #1612), the generated board bundle | No | Closes the slow hook, narrows the start-up time |
| Re-read the turn order just before the send | `hooks/antigravity-sidecar.ts`, `hooks/hook-messages.ts`, `scripts/board-messaging.ts` | No | Covers about 0.1 ms of window 2 |
| Compare `num_steps` before the send, if a live run proves it | `hooks/antigravity-sidecar.ts`, `hooks/hook-messages.ts`, `scripts/board-messaging.ts`, `scripts/board-serve.ts` | No | May narrow the no-hook case |
| #1609, a dismissed failed wake holds the next wake | `hooks/hook-messages.ts` (PR head line 126) | No | Fixes #1609 |

**#1609 reproduced on PR head.** After a failed wake was dismissed, the next message got no wake. With a one-line change to the gate, which ignores a message that is both dismissed and reported failed, it got its wake. This was run on the board code with a synthetic store and clock.

## How to repeat

Everything ran in a new experiment folder, `<temp>/tmp-c3`, with `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `TEMP` and `TMP` pointing inside it. Data was synthetic.

1. Export the two trees: `git archive a679f24f` and `git archive 542ba11c`, each unpacked into its own folder.
2. Baseline: in the PR tree, run `node --test tests/antigravity-wake.test.mjs`. Result: 18 of 18 passed.
3. Declarations: in the experiment home, run `node scripts/setup-agent.mjs --agent antigravity --antigravity-sidecar --home <experiment home> --apply --json` from the main tree. Move that home aside, repeat from the PR tree, and compare `.gemini/config/hooks.json` with `cmp`.
4. Generator hashes: load `hooks/local-agents.ts` through a Node module hook that makes one text edit in memory. Call `antigravityHooks` with `antigravityCommand` and `hookCommandArgs` on fixed inputs, then hash the result as JSON together with `hooks/hooks.json`.
5. World for steps 6 to 8: start the installed `agent-board.mjs --serve --no-open`. Play the app by running each command from `hooks.json` through `cmd /d /s /c`, with JSON on stdin holding `conversationId`, `hookEventName`, `transcriptPath` (under `.gemini/antigravity/brain/<conversation>/`), `artifactDirectoryPath`, `cwd`, and `invocationNum: 0` for `PreInvocation`.
6. Window 1: follow the sequence above the first table, then read `<mailbox id>.turns.json` and call `POST /api/messages/wake-poll`.
   - The delay in cases A and B is one line added after the first line of the installed `agent-board.mjs`: `Atomics.wait` for 2,600 ms when the arguments hold `--agent-status` and `PreInvocation`.
   - The stand-in patch in cases B and D adds, before `const internal = ['--hook-version',` in the installed `agent-board-hook.mjs`, a write that adds one to `started` in the turn order file. It takes no lock. A healthy turn counts twice, which does not change the gate's answer, because `Stop` copies `started` into `stopped`.
7. Hook timing: run `PreInvocation` 30 times, each followed by `Stop`, and poll the turn order file every millisecond.
8. Window 2: run the installed `sidecar.mjs --once` with `ANTIGRAVITY_AGENTAPI_EXE` set to `node` and `NODE_OPTIONS=--require=<stand-in>`. The stand-in acts when `argv[1]` is named `agentapi`. For the timing, add `performance.now()` marks to a copy of the sidecar. For the forced order, the stand-in runs the real `PreInvocation` hook before it exits.
9. #1609: use `createMessaging` from PR head with a synthetic clock: send, `wake-poll`, `wake-attempt`, `wake-report` failed, `dismiss`, send again, `wake-poll`.
10. Static read: search the bytes of `resources/bin/language_server.exe` for handler symbols and for the getters of `GetConversationMetadataResponse`, without running it.

## Not run

| Not run | Why |
|---|---|
| The Antigravity app, `agy`, or the real `agentapi` | This check does not drive the app. All app behaviour here comes from the live records on #1396 and #1612 or from the static read |
| Whether `agentapi get-conversation-metadata` prints `num_steps`, and when that number rises | Needs the running app |
| When the app writes the transcript during a turn, and how long it takes to launch a hook | Needs the running app |
| A hook killed by the app at its 3 s limit before the worker reads its input | Needs the app. Case A covers the worker's own 2 s limit |
| Linux and macOS | Only this Windows machine was used |
| A production version of any fix, and a rebuilt bundle | Bun is not installed and this check installs nothing. The stand-in patches went into the installed copies, and declarations were checked from the generator source |
| `tests/messaging.test.mjs` | Long, and not needed for this question |
| Merging #1612 with current main | Out of scope. The three declaration files are unchanged on both sides |

## Verdict and effect on the plan

**FAIL: both windows cannot be closed with no hook change.** The plan's "If it fails" column sends this back to the owner, to hold the release or move the wake to 0.26.0.

**The owner's decision, 2026-11-18:** the third choice below. The wake stays in 0.25.1, and the two remaining windows are accepted with a test and honest card wording.

Four things the owner had in front of them:

1. **The stated reason needs correcting.** R7 is not the blocker, because no hook change closes these windows. Moving the wake to 0.26.0 does not close them by itself, and holding the release helps only if the app changes. No date for such a change is known.
2. **M5b cannot be built as written.** Its first work item, "read the conversation's own state right before the send" (plan line 124), has no public source for that state.
3. **A third choice is not in the plan's column.** The owner could accept the remaining window with a test and honest card wording, as the plan already does for Codex and #1370 (plan line 41). That needs the owner's own word: the 11-16 decision asked for the windows to be closed, and the review rules count a message started in a running turn as P0 or P1 however many events lead there (`AGENTS.md:132`).
4. **Moving the wake reopens two plan items.** Section 2 says the release waits for this work (plan line 39), and moment 2 promises a start within 10 s on the Antigravity app (plan line 23).

Whichever release carries the wake, the script fixes above need no hook change. If it stays in 0.25.1, one live run should first settle the three `num_steps` questions, because they decide whether the no-hook case can be narrowed at all.

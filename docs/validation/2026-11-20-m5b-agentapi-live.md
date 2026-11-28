# M5b live run: does `agentapi get-conversation-metadata` show a turn running?

**Date:** 2026-11-20
**Plan:** `docs/dev/plan-0.25.1.md`, M5b ("One live run first settles whether `agentapi get-conversation-metadata` prints `num_steps`, whether it rises as soon as a turn starts, and how long the call takes")
**Verdict:** it does not. The printed answer has no step count and no run state, and it stays the same while a turn runs, so the board cannot check "idle" right before `send-message`. The call is fast (about 125 ms), but there is nothing in it to read.

## The answers

| Question (M5b, from C3) | Answer |
|---|---|
| Does `get-conversation-metadata` print `num_steps`? | No. The printed JSON holds only `response.conversationMetadata.metadata`: creation time, ids, the sidecar that made the conversation, and the model's static settings. No `numSteps`, `num_steps` or `trajectoryId` appears, even after a finished turn. |
| Does it rise as soon as a turn starts? | Nothing in the answer moves. Through a whole first turn and 90 s after a send, no field that could show progress changed (run 2). An answer after a finished turn and one 1.5 s into a running turn were the same, byte for byte (run 3). |
| How long does the call take? | 518 calls in two runs: median 125 ms, 90th percentile 138 to 141 ms, slowest 442 ms. |

C3 read the program file and found `num_steps` and `trajectory_id` in the response message. The command-line tool does not print them, so they are out of reach for the sidecar.

`agentapi --help` lists three commands and no others: `get-conversation-metadata`, `new-conversation` and `send-message`. None reports whether a conversation is running.

## What this means for M5b

- The "possible signal, unproven" of C3 (`docs/validation/2026-11-18-c3-antigravity-wake-windows.md`, window 1) is ruled out. The no-hook part of window 1 stays open, as the owner accepted on 2026-11-18.
- The remaining M5b work stands as planned: the hook worker writes the turn's mark first, so a slow hook no longer lets a wake into a running turn; #1609; the `agy` report; and the card line saying a message sent while the person starts a turn may join that turn.
- The M5b "done" record (an idle start within 10 s and a running turn held) is a separate live run on the finished branch, with the board's own sidecar.

## How it ran

| Item | Version |
|---|---|
| Antigravity desktop app | 2.32.1, Windows 11 |
| Node | 24.14.0 |
| Branch | #1612 at `b8abff5f` (the probe used none of its code) |

A test-only sidecar in a separate test home (not the person's own), turned on in the app's Automations page and turned off and moved out afterwards. It spoke only to conversations it made itself, on the `flash` tier, with synthetic prompts ("write the numbers 1 to 80", "reply with exactly PONG 7311").

1. Run 1 started a conversation, polled `get-conversation-metadata` every 250 ms until the answer held still for 20 s, then sent one message and polled for 90 s more. Its step pattern looked for `num_steps`; the answer is camelCase JSON, so run 2 followed.
2. Run 2 did the same, reading the JSON for any field named like a step, status, state, turn, trajectory or count, and logging every change. The answer never changed.
3. Run 3 read `agentapi --help` and each command's help, then called the read-only command once while idle and once 1.5 s after a send into that conversation. The two answers were identical.

The raw logs stay in the test home, because they hold the test home's folder names and conversation ids.

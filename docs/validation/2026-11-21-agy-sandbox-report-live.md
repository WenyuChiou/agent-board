# agy's terminal sandbox and the board report (#1384)

Date: 2026-11-21. Verdict: **cause found; the conversation's own output carries the report to the board.** A report the sandbox refuses prints one marked line; agy keeps that line in the conversation's transcript, and the conversation's next hook applies it.

## Versions

- agy (Antigravity CLI) 1.5.10 and 1.5.13, default model, Windows 11 build 10.0.26300.
- Node v24.14.0.
- The kept test home of `docs/validation/PARITY-CHECKLIST.md`. Its agy settings got two keys for these runs, `enableTerminalSandbox: true` and `toolPermission: proceed-in-sandbox`; a copy was kept and put back afterwards.

## Cause

A probe script, run by the model as its own terminal command, tried a file create in each place and a TCP connect to a closed port on 127.0.0.1:

| agy setting | Board folder (inside the user profile, outside the project) | `TEMP` | 127.0.0.1 |
|---|---|---|---|
| default mode, no sandbox | ok | ok | reaches the port |
| the two sandbox keys above | `EPERM` | ok | reaches the port |

- `EPERM` on the lock's create, with no lock file there, is what `withLocalLock` reports as `LOCK_DENIED`, the 11-12 failure.
- agy's docs say `auto` mode turns the terminal sandbox on by itself and is the default where offered. Both accounts tried here print `--mode auto is not available for this account`, so the sandbox is on only for some people, or when they turn it on.
- agy's own hooks are not sandboxed: they write the board folder.

## What the hooks can read

agy 1.5.13, `agy --print`, the board's hooks as installed plus a temporary capture hook on `PostInvocation` and `Stop` that copied the transcript at the moment it fired. The model ran one synthetic script per run as its terminal command; each printed a marked line and exited 3.

1. The script's own create in the board folder got `EPERM`, so the sandbox was on.
2. The command's output (a `MODEL/GENERIC/DONE` entry, the step after the planner's tool call, holding `Command output:` and the printed text) was already in the transcript at the first `PostInvocation` after the command and at `Stop`.
3. `PostInvocation` carries `transcriptPath` and `conversationId`, as `Stop` does.
4. A 4 KB line came through whole. A 20 KB output was cut to about 10 KB ("truncated 10296 of 20180 bytes from the middle"), the full text kept under the conversation's `steps/<n>/output.txt`. So the marked line is capped at 4096 bytes, and a line that does not parse whole is refused.
5. Both scripts exited 3 and the entry said `Command exited with code 1.` Nothing reads the exit code; the marked line is what counts.

## Not shown

- The Antigravity desktop app with the sandbox on.
- macOS and Linux sandboxes: the CI tests use a read-only folder instead.
- `auto` mode itself, which neither account offers.

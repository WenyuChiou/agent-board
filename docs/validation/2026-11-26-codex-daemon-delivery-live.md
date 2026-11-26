# Codex terminal on its background daemon: a delivery run, Windows, 2026-11-26

This is the delivery run for #1652: a board message answered on the board page, sent to an idle Codex terminal thread on the daemon, timed from the click to the thread's `task_started`. It follows the timing run in `2026-11-26-codex-daemon-short-wait-live.md`. No model call was made: a local stand-in server answered "ok". No thread ids, tokens or home-folder paths are written here; the run used a test home, a short folder of its own, so nothing touched a real Codex home or board.

## Versions and setup

| Item | Value |
|---|---|
| Codex CLI | 0.172.0 (npm package, run from the test home's npm cache) |
| Daemon | 0.172.0, the managed copy the CLI installs under the test home. A 0.167.0 daemon was tried first: the receiver needs 0.169.0 or newer (`MIN_DAEMON`, already on main), so it delivers nothing there and the card stays on Copy |
| Board | `agent-board.mjs` built from the #1894 branch, `--serve`, its own runtime folder in the test home |
| Model | a local stand-in server that answers "ok" to every request |
| Window | a pseudo console (`CreatePseudoConsole`), `cmd.exe /k`, then `codex` or `codex resume <T>` typed |
| System | Windows 11 10.0.26300, Node 24.14.0, on a busy computer (several other agents and the Codex desktop app running) |
| Clock | system wall clock: the page's `Date.now()` at the click, the store's claim time, the rollout file's `task_started` time |

## Runs

| Run | Receiver (#1894) | Window | Click to claim | Click to `task_started` | Result |
|---|---|---|---|---|---|
| 1 | list read limit 2.5 s | open, thread idle | about 1.5 s | about 3.3 s | short route; the board's text is the turn's user message |
| 2 | list read limit 2.5 s | open, thread idle | about 7.9 min | about 7.9 min | the process list read took longer than the 2.5 s limit, read as "cannot be read", so the message took the 10-minute route (10 min from the thread's last turn) |
| 3 | limit 10 s (26a3fe79) | open, thread idle | 1.26 s | 3.85 s | short route |
| 4 | limit 10 s (26a3fe79) | closed, then reopened with `codex resume <T>` | 0.29 s | 5.30 s | see below |

After run 2, #1894 raised the limit to 10 s for the read (11 s for the receiver's own timer), with a test that a read of several seconds is still an answer.

Run 4, step by step:

- The window was closed (pseudo console closed). About two minutes later, after the daemon's 60 s unload, the card for the next question offered only Copy: the thread was no longer listed, so the receiver had nothing to send to. This is the bound the owner accepted on #1652: a closed window's thread is reached only while it is still loaded.
- `codex resume <T>` was typed in a new window. At the first look, 6.7 s after Enter, the card offered Send again.
- Send: the claim came 0.29 s after the click and `task_started` 5.30 s after it.

In every run the rollout shows the board's text as the turn's user message, with the board message's nonce as its `client_id`, and the stand-in's "ok" as the answer.

## The process list on Windows

The receiver reads the list with PowerShell (`Get-CimInstance Win32_Process`), once when it decides and once right before the join. Timed on this computer during the runs:

| Way | Time per read |
|---|---|
| A new PowerShell per read (what the receiver does) | 1.6 to 5.7 s |
| One PowerShell kept open, the same query sent again | 0.5 to 0.7 s (the first answer 2.4 s, start-up included) |

Two cold reads explain most of the 3.3 to 5.3 s from click to turn. A kept-open PowerShell would bring that near 1.5 to 2 s.

## Limits

- Every message ended `uncertain` (`ACK_MISSING`): the stand-in model answers "ok" and never writes the board's receipt. The turn start and the user message in the rollout are the evidence of delivery here; a run with a real model is not done.
- A pseudo console, not a real terminal window.
- One computer, one thread, four runs.

# Codex CLI: a board message through the running daemon, 2026-11-04

For #557. Run by claude (the maintainer's PM session) with the owner's consent, on the owner's computer: Windows 11, Codex CLI 0.163.0, Node 24.14.0. Thread and turn ids, the board token and folder paths are left out.

## Setup

- A disposable Codex CLI session in a scratch folder, started with `codex -s read-only -a never "Run exactly this one shell command and wait for it to finish: Start-Sleep -Seconds 420. Then end your reply with exactly: Done."`. Its turn stays active while the command runs.
- A board in a scratch home with a synthetic `progress.md`, started with `--serve-child`.
- `connectCodexProxy({ boardUrl, executable, thread, turn, surface })` from `scripts/codex-message-connector.mjs`, with the absolute path of the installed `codex.exe` and the running thread and turn.
- One message sent with `POST /api/messages/send`: id `AB-LIVE-557`, text `Board check for #557: reply with the ACK line only, then continue your current task. Do not change any file.`

## Receipt

| Stage | Before the fix (head 72ed6e7) | After the fix |
|---|---|---|
| Connector attached | 80 ms after the board started | 97 ms |
| `queued` | 15:27:42 UTC | 15:39:26 UTC |
| `accepted` | 15:27:43 | 15:39:28 |
| `acknowledged` | never: `uncertain` with `ACK_TIMEOUT` at 15:28:44 | 15:39:33 |
| Reply | none | none asked; the ACK line only |

Both times the Codex terminal showed the board message inside the running turn, then the model's `ACK <nonce>` line, then the command went on. Only the board's side differed.

## Cause

The daemon sends a thread's events only to connections subscribed to that thread. `thread/start`, `thread/resume` and `thread/fork` subscribe; the protocol also has `thread/unsubscribe`. The connector listed loaded threads and steered, so it got the steer's response but never the turn's `item/completed`.

A probe that logged every notification during a steer, without subscribing, saw only connection-level ones (`configWarning`, `remoteControl/status/changed`, `account/updated`). After `thread/resume` with `excludeTurns: true` on the loaded thread, the same probe saw the turn's hook, item and token events, and the `agentMessage` item `ACK <nonce>` 7 seconds after the steer.

## Fix

After `initialize`, the connector checks that the thread is in `thread/loaded/list` (`TARGET_MISMATCH` otherwise, so a saved thread is never opened from disk) and calls `thread/resume` with `excludeTurns: true` and no overrides. Tests:

- `the connector initializes, steers and reads the ACK through a WebSocket-only mock proxy`: its mock now sends a turn's events only after `thread/resume`, as the daemon does, and checks the call order.
- `the proxy connector never resumes a thread the running Codex has not loaded`.

## Side effects checked

- **The running turn.** Resuming a loaded thread with no overrides started no turn and changed nothing visible in the terminal; the shell command and the turn went on.
- **The thread's goal.** On resume the daemon sends the new subscriber the goal's state: `thread/goal/cleared` when there is none, `thread/goal/updated` when there is one. A synthetic paused goal set on the disposable thread was unchanged after a second connection resumed it (same objective and status), and was cleared afterwards.

## Not covered

- Approval requests while the board is subscribed. The session ran with approvals off. The connector still never answers an approval request; whether the daemon also sends one to the board's connection, and still waits for the terminal's answer, is not tested.
- The Codex desktop app: no shared control socket was reachable there on 2026-10-20 (OS error 10050).
- Linux and macOS.
- An idle Codex CLI session: this adapter only steers an active turn.

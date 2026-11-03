# Send to Claude: live checks

Date: 2026-11-03. Part of #316.

## How the checks were run

- **Machine:** Windows 11, Claude Code 2.1.316, Node 22.
- **Real:** Claude Code in a terminal (a pseudo console, keys sent by script), the mod loaded with
  `--plugin-dir`, the board's own script and page, the message hub.
- **Not real: the model.** Nobody logged in to the test home, so a small server on 127.0.0.1 played
  the model API. It answers a board message with `ACK <nonce>` on the first line. So this does not
  show that a real model follows the ACK line. L1 in `2026-10-20-send-spikes.md` showed that on
  2.1.302, with an earlier form of the header and with throwaway code.
- **Isolated home:** the 13 variables under one temp folder, `CLAUDE_CODE_*` and `ANTHROPIC_*`
  cleared, a made-up API key that went only to that server.

## Results

| Check | Result |
|---|---|
| Binding | The session registered as `claude`, its full id, `scope: session`, about 6 s after starting. |
| Idle | Sent, acknowledged 1.1 s later. The card showed `Claude got this.` |
| Reply | The reply's body reached neither the hub nor `progress.md`. |
| Busy | During a 12 s turn the message stayed `queued` and the connection stayed live. It was taken when the turn ended. |
| Take back | During a 25 s turn: `Claude is working. It gets this when this step ends.` with Take back. Pressed: the line went and the message never reached the model. |
| Esc | A message sent after a stop: `Stopped in Claude. Not delivered.` with Send again and Copy message. |
| After Esc | A second message stayed `queued` until the person typed, then was delivered once. |
| Closed session | After `/exit` the connection was gone and the card showed `Claude isn't connected to this board. Copy this and paste it there.` with Copy answer. |

The page was driven in the app's browser pane, its buttons pressed by script, as the window was not
on screen.

## Not run

- **A real model.** Needs the owner to log in once in a test home.
- **Desktop app (L4).** `session.start` says `isInteractive: false` for a session a program started,
  so the receiver does not start there, and its cards stay on Copy.
- **macOS and Linux.** The POSIX address check ran only against a mock.
- **Mod hot reload.** Presenting the old connection is covered by a test, not a live run.

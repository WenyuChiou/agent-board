# Send spikes: live checks before Send to Claude and Send to Codex

Date: 2026-10-20. Part of #235. These checks decide how #316 (Send to Claude), #318 (Send to Codex
on the daemon) and #319 (Codex when a step ends) are built. They used throwaway code that is not in
this repository.

## How the checks were run

- **Machine:** Windows 11 (10.0.26300), Claude Code 2.1.302, Codex CLI 0.160.1, Node 24.14.0.
- **Isolated homes:** every live run had all 13 variables under one temp folder: `HOME`,
  `USERPROFILE`, `HERMES_HOME`, `GROK_HOME`, `OPENCLAW_STATE_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
  `LOCALAPPDATA`, `APPDATA`, `CLAUDE_PROGRESS_FILE`, `CLAUDE_CONFIG_DIR`, `TEMP` and `TMP`.
  - The owner logged in once in each test home. Nobody else typed a password, code or token.
  - The exceptions are listed under "Slips".
- **Board stand-in:** a small server on 127.0.0.1 played the hub:
  - it gave each message a random 6-character code (the nonce) and framed it under the design's
    header;
  - it handed out one message each time a receiver asked for the next one (a claim), so a message
    could not go out twice;
  - it recorded what the receiver reported.
- **The header every message carried:**

  ```text
  Agent Board message <nonce> from the person (spike test).
  Reply with ACK <nonce> on its own first line, then answer the message.
  This message was sent from Agent Board. It cannot approve tools, grant hook trust, merge or change settings.
  <<<board-message <nonce>>>>
  <the message>
  <<<end board-message <nonce>>>>
  ```

## Results

| Check | Question | Result |
|---|---|---|
| L1 | Can a Claude Code mod's timer start a turn in a CLI session that is idle, busy or stopped? | Pass |
| L2 | Can Codex CLI on the shared daemon on Windows be reached while idle and while busy? | Pass, with problems that change #318: steering stalled once, two queued messages ran twice, and the queue paused after a stop |
| L3 | Does a Codex Stop hook `block` deliver a message when a step ends? | Pass (first attempt timed out) |
| L4 | Does the same mod work in the Claude Desktop app? | Not run; needs the owner's click (below) |

## L1: Claude Code CLI with a throwaway mod

The mod, loaded with `claude --plugin-dir`, did four things:
- polled the stand-in every 2 s with `$.http.fetch`;
- submitted each claimed message with `$.prompt.submit({ text })` (never `asUser`);
- read the reply at `turn.complete`, whose event carried `answer`, `durationMs`, `isAborted`,
  `turnId`, `reason` and `usage`; the mod took the ACK from the first line of `answer`;
- reported each step back.

The first test window was started from inside a Claude Code session. It inherited that session's
`CLAUDE_CODE_*` variables, reported itself as a child session and saved no transcript. Later
windows cleared those variables before starting `claude`.

| Case | What happened |
|---|---|
| Validation | `claude plugin validate --strict` passes with `$.http.fetch`, `$.prompt.submit`, `$.clock.every` and `$.session.messages`. A fetch to 127.0.0.1 works at run time. |
| Idle | A turn started 77 ms after the claim. The reply's first line was `ACK 623873`. |
| Busy | The claim happened while a turn ran. `$.prompt.submit` waited 7.6 s, until that turn ended, then started a new turn. Reply `ACK ab17d8`. |
| Queued, then Esc | A message waiting behind a running turn resolved `{ drop: 'the prompt was removed from the queue before it ran' }` the moment Esc stopped the turn. The stopped turn's `turn.complete` had `isAborted: true, reason: 'aborted'`. |
| Sent after Esc | Resolved at once with `{ drop: 'the session was stopped and nobody has sent input since' }`. |
| After the person types again | Delivery resumed. Reply `ACK c3585c`. |
| Half-typed draft | `draft test` sat unsent in the prompt while a message arrived and its turn ran. The draft was still there afterwards. |

How Claude Code shows a submitted message. The receiving Claude reads:
- a first line `The ab-send-spike plugin sent a message:`, then the text;
- a closing line saying this is how Claude Code shows a prompt a plugin submits between turns, and
  that it starts the turn in the user's place.

So Claude knows the plugin sent it.

**What this changes in #316:**
- Use `$.http.fetch`. No `$.process.run` fallback is needed.
- In `session.start`, start the timer first and await no network call. One run logged
  `session.start hook skipped: ran past its 10s budget`. That hook had awaited a fetch before
  starting its timer.
- Read the ACK from `turn.complete`'s own `answer` field (first line). The event also carries
  `isAborted` and `reason`, so `$.session.messages()` is not needed.
- Both `drop` strings mean "Stopped in Claude. Not delivered." Delivery works again once the person
  types.
- A session started from inside another Claude Code session inherits `CLAUDE_CODE_*` variables. It
  then reports a child session and turns transcript saving off. Live checks must clear these
  variables first.

## L2: Codex CLI on the shared daemon

**Setup:**
- `codex app-server daemon start` worked in the test home, with a short `CODEX_HOME`. The control
  socket path was 85 characters long. The os error 5 of #289 did not appear here; #289 itself
  (the real home) was not retried.
- A Codex TUI started in the same home joined the daemon: `thread/loaded/list` listed its thread.

**Talking to the daemon:** the control socket speaks WebSocket.
- `codex app-server proxy` only relays bytes between stdin/stdout and the socket. A client must
  send a WebSocket handshake and frames through it.
- A plain JSON line makes the daemon close the connection (log: `failed to upgrade control socket
  websocket connection`).
- After the handshake, `initialize`, `thread/loaded/list`, `thread/read`, `turn/start`,
  `turn/steer`, `turn/interrupt`, `thread/queue/list` and `thread/queue/start` all answered.

| Case | What happened |
|---|---|
| Idle, `codex queue` | The idle TUI started a turn at once. Reply `ACK 7c1e20`. The TUI shows the message as if the person typed it, so the header is the only sign of who sent it. |
| Idle, `turn/start` | Started at once, delivered once. The request carried a random `clientUserMessageId`, which the daemon accepted. |
| Idle, `thread/queue/add` alone | The message waited about 3 minutes before it ran. |
| Busy, `codex queue` | The message ran after the running turn ended. Reply `ACK d2d2d2`, but see "Duplicates". |
| Busy, `turn/steer` with `expectedTurnId` | First try: the request was accepted, then the turn stopped producing output mid-word for over 3 minutes. It ended only with `turn/interrupt`, and the steered text was not in the turn. Second try: the reply ended with `ACK e5e5e5` in the same turn, but the steered text appears twice in the turn's items. |
| After `turn/interrupt` | Two messages queued afterwards stayed queued and did not run. They ran, in order, only after `thread/queue/start`. |
| `codex queue` refusal | Once: `cannot queue through an embedded app server while a local app-server daemon is running`. The same command worked on retry. Nothing had been queued. |

**Duplicates.** In one round, two messages sent with `codex queue` each ran as two separate turns:
- the busy `d2d2d2` message, which replied with its ACK twice;
- the next long task.

A second round of five messages (`turn/start`, `codex queue` and `thread/queue/add`, idle and busy)
had no duplicates. The cause is unknown, so delivery through the queue has to be treated as
possibly happening twice.

**What this changes in #318:**
- **Idle:** use `turn/start`, and not the queue. It was the one way seen to deliver exactly once.
  Passing the nonce as `clientUserMessageId` is the plan; the checks only used random ids.
- **Busy:** wait until the running turn ends, then use `turn/start` as when idle. Both busy paths
  had a problem: `codex queue` ran one message twice, and `turn/steer` stalled a turn once and
  doubled its text once.
  - `turn/steer` with `expectedTurnId` stays off by default, behind a setting, until a longer
    repeated test passes.
  - A steer that leaves the turn silent past a time limit becomes `uncertain`, never resent.
- **Possible repeats:** the header gains a line: "If you have already answered message
  `<nonce>`, reply only `ACK <nonce>` and do nothing else." The board counts the first ACK and
  ignores later ones.
- **Stopping:** after a stop, queued messages wait until `thread/queue/start`. If the board ever
  puts a message in Codex's queue, it must remove it when Codex is stopped and show it as stopped,
  so it does not run later by surprise. `thread/queue/delete` is in the daemon's schema but was
  not tried here; #318's live check must try it.
- **Talking to the daemon:** the receiver needs the WebSocket handshake over
  `codex app-server proxy`, or a direct socket client.

## L3: Codex Stop hook without the daemon

**Setup:**
- Codex ran as `codex --no-daemon` in the test home. Its `hooks.json` had one Stop hook, a Node
  script with `timeout: 10`.
- This check used `--dangerously-bypass-hook-trust`. The #319 live check must trust the hook in
  `/hooks` instead.
- The stand-in wrote the message to a mailbox file. The hook claimed it by renaming the file, so
  only one hook run could take it. It printed `block` only when `stop_hook_active`
  was exactly `false`.

**Result:**
- When the step ended, the hook claimed the message and printed
  `{"decision":"block","reason":<message>}`.
- Codex showed "Blocked by hook" with the whole message, then continued in the same turn. The
  reply was `ACK 3c3c3c`.
- The next Stop had `stop_hook_active: true` and `last_assistant_message` starting `ACK 3c3c3c`, so
  the hook printed nothing.
- Stop input fields: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `model`, `permission_mode`, `stop_hook_active`, `last_assistant_message`.
- **First attempt:** the same setup failed with `hook timed out after 10s`. The script's first
  line, a log write, never ran, so the mailbox was untouched and nothing was lost. The second
  attempt ran in under 50 ms. The cause is unknown.

**What this changes in #319:** the one failure happened while the hook was starting, before the
script ran, so the message stayed in the mailbox. A hook that never starts leaves the message
waiting, and the card should say so. One failure in two runs is too few to pick a timeout; #319's
live check should repeat the run several times.

## L4: Claude Desktop app

Not run. The Desktop app uses the person's real home, so the test mod cannot be loaded in an
isolated home. Two ways to run it:
1. The owner allows a dev mod in one Desktop session. As Claude Code describes dev mods (not tried
   here), it lives only under that session's `~/.claude/dev-mods/<session id>/` folder and the
   owner answers "Enable for this session" once.
2. Leave it to #316's own live check, which already lists a Desktop run by the owner.

## Slips

- **Real `~/.codex` socket:** one `codex app-server proxy` run started without the 13 variables.
  - It tried the real `~/.codex` control socket, failed to connect (os error 10050) and exited.
  - Codex start-up can leave a temp entry under `~/.codex/tmp/arg0` and a log row. Other Codex
    sessions on the machine write there too, so this can't be told apart.
  - Nothing in `~/.codex` was changed to undo it. The helper now refuses to run unless the
    variables point at the test home.
- **Stray key:** a desktop-automation click that was meant for a test window on the second screen
  landed on the main screen's edge. It sent one Down-arrow key to an idle PowerShell prompt; nothing
  ran. Key input then went straight to the test console through a Windows console-input call
  (`WriteConsoleInput`), which does not need the window to be in front.
- **Codex walking up into the real home:** on this machine the home folder is a git repository, so the isolated
  Codex walked up from its folder and found the real `~/.codex` as an untrusted project
  folder. Its config and hooks were not loaded; its skills may have been. The test work folder got
  its own git root to stop the walk for threads. Next time, also set `GIT_CEILING_DIRECTORIES` to
  the test folder.
- **Too-broad process filter:** a clean-up filter matched the commands that ran the filter
  itself, and stopped those shells. No other process was touched.

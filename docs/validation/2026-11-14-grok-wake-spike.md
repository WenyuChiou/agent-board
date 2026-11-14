# Grok Build: an outside way into an idle session (spike for #1404), 2026-11-14

Run by a Claude Code subagent (Claude Sonnet 5.5) for the maintainer's PM session, on the owner's computer, in a separate test home. Session ids, process ids, tokens and folder paths are left out. Times are US Eastern.

## Question
Does Grok Build offer a documented outside way to make an IDLE interactive session start a turn, with nobody typing in its window?

## Versions / OS
- grok 1.0.62 (1474f9cbdd91) [stable], Windows 11 10.0.26300, run only in a separate test home. Model shown in the TUI: Grok 4.7 (high).
- Docs read: xai-org/grok-build `crates/codegen/xai-grok-pager/docs/user-guide/` (files 09, 10, 14, 15, 17, 20, 22, 23) via `gh api`; `grok --help`, `grok agent --help`, `grok agent serve|stdio|headless|leader --help`, `grok leader --help`, `grok plugin --help`, `grok sessions --help`.
- Code read (no edits): scripts/background-resume.ts, resume parts of scripts/board-serve.ts, docs/MESSAGING.md (row for Grok: "Planned (#1404)").

## Candidates

### 1. Local server / API the RUNNING interactive session listens on (kind B): NOT OFFERED
- The TUI is not documented as a listener. `grok agent serve` (WebSocket, default 127.0.0.1:2419, `--secret`) and `grok agent stdio` (ACP) start their OWN agent; a client drives sessions it creates or loads (docs 15-agent-mode.md). Nothing says an ACP client can submit a prompt into a session an open TUI window is showing.
- `--leader` / `grok leader list|info|kill` (shared backend process, socket ~/.grok/leader.sock): leader mode is off by default (`[cli] use_leader`, docs 26-config-reference.md). No doc says a second client can prompt the TUI's live session. Not tested. Verdict: not offered (leader: undocumented, unverified).
- `grok agent headless --grok-ws-url` connects the agent to a relay whose URL is configurable (the docs also describe running your own). Nothing in the docs says it can prompt a session an open TUI window shows, and it was not tried.

### 2. Plugin / hook / extension that submits a prompt (kind A): hooks and plugins do NOT; the `monitor` tool DOES
- Hooks (docs 10-hooks.md): UserPromptSubmit can only block a prompt the user typed; `Stop` can keep a turn going only while a turn is ending; `Notification idle_prompt` is passive ("Every other event is passive"). No hook starts a turn on an idle session. Plugins (09-plugins.md) bundle skills, commands, agents, hooks, MCP servers; none is documented to submit a prompt. Verdict: does not.
- Scheduler / `/loop`: "Every fire runs in a detached background subagent; there is no option to run one as a turn in the conversation" (20-background-tasks.md). Does not.
- `monitor` tool (20-background-tasks.md): each new line in a watched command's output becomes a notification in the conversation; "Any of them can wake the agent for a new turn (... monitors on events ...)"; `persistent: true` lasts the session lifetime.
- LIVE PROBE (works): interactive TUI started by me under winpty. One initial prompt told it to run a persistent monitor `tail -n0 -F grok-wake-box.txt` (tool call allowed in 6 ms; `--allow 'Bash(tail *)'` given). The session went idle ("1 monitor still running"). At 10:29:48 I appended one line to the file from a separate shell (nothing typed in the Grok window). The session log (updates.jsonl) shows within about 1 s a `user_message_chunk` with `syntheticPrompt:true, hideFromScrollback:true`:
  `<monitor-event task_id="…"> [Watch agent board wake box] board message: wake-probe-1 from agent-board </monitor-event>`
  then a new model turn (promptId `notifications-...`) whose reply was `GOT board message: wake-probe-1 from agent-board`. So a monitor wakes an idle session and the model sees the line as a message.
- Limits seen: (a) the monitor must be started once by the session itself, so one turn has to run in that session first (first prompt, project rule or skill text). A session that never started it cannot be woken. (b) The model sees only the monitor-event line, so sender, address and an ACK instruction must be in the line or in the standing instruction. (c) The wake message is flagged hideFromScrollback; I read the session log and the pty text stream, not a real screen. (d) "If a monitor produces too many events, Grok stops it automatically": how many board messages a monitor takes before Grok stops it, and how a stopped monitor recovers, were not tested (one message only). (e) It dies with the session; a restart needs the bootstrap turn again.
- Terms: documented built-in tool, runs inside the user's own signed-in Grok session; no token reuse, no private API, no wrapping. Terms were not assessed: xAI's legal terms page was not read.

### 3. Own resume command in the background (kind C, background-resume.ts): one attempt on an open session (with a persistent monitor running) did not start a turn; documented for closed ones
- Command (docs 14-headless-mode.md, 17-sessions.md): `grok -p "<text>" --resume <session-id> --output-format json` (JSON carries `sessionId` and the result). `-r` errors if the session does not exist; `-s` only creates. Docs: "concurrent same-ID is best-effort". background-resume.ts already finds `~/.grok/bin/grok(.exe)`.
- LIVE PROBE (one attempt, did not start a turn): with the interactive session above open and idle (monitor running), I ran the command in the test home, from the same project folder. It printed nothing for 120 s, wrote nothing to the session (updates.jsonl unchanged, no RESUMED), and my 120 s timeout ended it. No ACK, no turn, nothing in the open window. Cause unverified (open-session lock, or headless waiting on the session's running monitor). I did not retry (turn budget). Whether it works with the window closed is documented but not live-tested here; the issue's goal is an open idle session.
- Terms: `grok -p` and `--resume` are the documented headless route (scripts, CI); no token or private-API use. Terms were not assessed (legal page not read).

## Recommended route
Kind A through the documented `monitor` tool, not background resume:
1. The board appends one line per message to a mailbox file per Grok session; the session runs a persistent monitor on it (documented; wake proven live above).
2. Bootstrap: the session must start the monitor itself (the /agent-board command text, a skill or a project rule tells the model to do it at start). One prior turn per session is unavoidable.
3. Each line carries sender, address and "reply, then ACK" so the board can read the ACK back. How the ACK returns (the model runs the agent-board CLI or writes a file through its own tool) was not probed.
Keep `--allow-resume` background resume as the closed-session fallback only, off by default.

## What a receiver PR needs
- Mailbox file path per Grok session and a writer in board-serve (append one line, size-capped, no newlines inside a body, since each line is one event).
- Bootstrap text so the session starts the monitor (and restarts it after a restart), plus a liveness check. The `Stop` hook input carries `backgroundTasks` (type `monitor`, status), which could tell the board the monitor is alive (documented in 10-hooks.md, not probed).
- ACK return path and its row in docs/MESSAGING.md; the card must say a first turn must have run.
- A dated record in docs/validation/ for the full path (board click, nothing typed in Grok, reply with ACK on the card). My probe covers only: file append, wake, model reply. No board, no ACK.
- Unverified: whether a permission prompt appears in plain default mode for the monitor's command (I passed an allow rule); behaviour when a message arrives mid-turn.
- Re-test resume on a closed session separately if kept as the fallback.

## Probe accounting and clean-up
- Model turns: 2 (initial prompt, monitor wake), plus one resume attempt that started no turn and left nothing in the session log.
- Started and stopped: winpty/grok TUI, its sleep feeder, the monitor's tail. `grok leader list` in the test home: "No leader candidates found". Left in the test home: its session folder and the watched file in the project folder (test data).

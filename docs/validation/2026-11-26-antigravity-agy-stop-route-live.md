# Antigravity CLI (`agy`) Stop continuation route (Route H): Spike S2 and live check

Date: 2026-11-26. Part of #1841 (`docs/dev/plan-0.26.0.md`, L6, spike S2, Q3).

## Decision (Spike S2)

- **Chosen route:** Route H as a second sequential Antigravity `Stop` hook handler (`StopWait`, `30 s` host hook timeout, `28 s` internal wait cap) returning `{"decision":"continue","reason":...}` when the model finishes with a waiting `[?]` question on `progress.md` and a local board page was visible within `30 s` (`pageAgo <= 30000`).
- **Rejected alternatives:**
  - External `agy --conversation ...` / `continue` command: would act as a second writer to the active session.
  - `--wait-message`: deferred to 0.27.0.
- **Constraints kept:** Reads no Antigravity port, token, or sign-in; polls only the board's own loopback `/api/ping` and mailbox store (`server.lock` / `server.owner`); holds no mailbox claim while waiting (B3.4); accepts only `agy TUI` (`.gemini/antigravity-cli`) and leaves `IDE` / unknown paths to `nextTurn`.

## Host

- Windows 11, Node 24.12.0, Antigravity CLI (`agy`) 1.5.13 (probes R0–R7 and `-p` E2E) and `agy` 1.5.18 (interactive `--prompt-interactive` ConPTY TUI checks).
- Isolated throwaway test homes (with `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` pointed into temporary folders) and synthetic prompts/data only; real home directories, sign-ins, and sessions were not touched.

## Probe runs R0–R7 (`agy 1.5.13` isolated `hooks.json` `Stop` contract)

| Row | Check | Result | Measured notes |
|---|---|---|---|
| R0 | Isolation gate (`agy -p="..."` reads temp `hooks.json`, logs `Stop` stdin keys) | **PASS** | `6.4 s`, exit `0`. `transcriptPath` under `.gemini/antigravity-cli`. Exact keys: `artifactDirectoryPath`, `continuationActive`, `conversationId`, `cwd`, `error`, `executionNum`, `fullyIdle`, `hookEventName`, `lastUserInput`, `modelName`, `terminationReason`, `transcriptPath`, `workspacePaths`. |
| R1 | Single `Stop` returning `{"decision":"continue","reason":...}` | **PASS** | `16.2 s`, exit `0`. Model received `reason` and printed `ACK ...` and chosen answer. **Key host behavior:** `continuationActive` stayed `false` across all invocations (`executionNum` `0..10` in an un-gated run that stopped at 10 continuations); Route H therefore relies on one-shot store claim consumption and an `executionNum < 8` loop cap rather than `continuationActive`. |
| R2 | Two sequential `Stop` handlers (`timeout: 3` then `timeout: 30`) | **PASS** | `14.4 s`, exit `0`. Handler #1 finished before Handler #2 started (`sawH1DoneAtStart: true` on every Stop), and Handler #2's `continue` continued the turn cleanly when Handler #1 returned `{}`. |
| R3a | `8 s` wait under `timeout: 30` | **PASS** | `21.4 s`, exit `0`. Continuation delivered and answered after an `8 s` delay. |
| R3b | `35 s` wait under `timeout: 60` | **PASS** | `51.6 s`, exit `0`. Confirmed `agy 1.5.13` honors custom hook `timeout > 30` without a hard `30 s` kill. |
| R4 | Fail-open on timeout (`timeout: 2`, `5 s` sleep) and exit `1` | **PASS** | Timeout (`8.0 s`, exit `0`) and non-zero exit (`6.3 s`, exit `0`) both failed open and printed the model's turn output cleanly. |
| R5 | Chained continuations across multiple questions | **PASS** | `20.2 s`, exit `0`. `executionNum` incremented `0 -> 1 -> 2` across two chained `continue` responses and stopped cleanly on `{}`. |
| R6 + R7 | Five consecutive runs extracting `ACK <nonce>` via `scripts/antigravity-meta.ts` (`antigravityTranscriptSize` + `antigravityReplyFirstLines`) after `1 s` wait | **PASS (5/5)** | Wall-clock times: `30.0 s`, `15.8 s`, `14.7 s`, `11.6 s`, `12.6 s` (all exit `0`). Every run extracted exact `["ACK <nonce>"]` from `transcript.jsonl`. |

## End-to-end live Route H run (built `agent-board.mjs` + `setup-agent.mjs`)

- Installed hooks with `node scripts/setup-agent.mjs --agent antigravity --lang en --apply` in a fresh isolated test home (`Stop` had sequential `timeout: 3` then `timeout: 30` entries).
- Started `agent-board.mjs --serve --no-open`, sent a visible page poll (`x-board-visible: 1`), and ran `agy -p="..."` with a no-tool question prompt (`Blue or green?`).
- `8.99 s`: `Stop` Handler #1 extracted `- [?] Blue or green?` to `progress.md`; `POST /api/messages/send` sent `"Blue"` (`HTTP 200`, `line: nextTurn`, `surface: agy TUI`).
- `StopWait` claimed `"Blue"`, returned `{"decision":"continue","reason":...}`, and saved its `AckClaim`.
- Model continued the same turn and printed `ACK <nonce>` and `Blue noted.`.
- **Result (`9.27 s` from send to acknowledged receipt; `10.56 s` from send to exit; `19.55 s` total; `0` errors in `hook-errors.log`):** `messages.json` recorded `status: "acknowledged"`, `reply: "ACK <nonce>"`, `error: ""`, `hops: 1`; `progress.md` checked `- [x] Blue or green?`.

## Interactive `agy --prompt-interactive` TUI live checks (`agy 1.5.18`, ConPTY)

- **Case A — Board reply within `StopWait` window (`agy --prompt-interactive`, PASS):**
  - After `Stop` #1 wrote `- [?] Blue or green?` to `progress.md`, `agy` TUI continued displaying an active spinner (`Working...` / `Generating...`, `esc to cancel`) while `StopWait` held the turn open.
  - Sending `"Blue"` via `POST /api/act` (while polling `GET /api/board` with `x-board-visible: 1`) was claimed by `StopWait` in `0.31 s`, continued the same turn (`ACK <nonce>` and `Blue noted.`), checked `- [x] Blue or green?`, and recorded `status: "acknowledged"`, `reply: "ACK <nonce>"`, `error: ""`, `hops: 1` in `6.26 s` from send to acknowledged receipt, with `0` errors in `hook-errors.log`.
- **Case B — Typing in `agy` TUI while `StopWait` holds the turn open:**
  - After entering a second turn (`Red or yellow?`) and waiting `2.0 s` into `StopWait`, sending `"Red"` + `Enter` directly to the ConPTY TUI did not block typing and did not cancel `StopWait`.
  - Instead, `agy 1.5.18` queued the typed input and displayed `▸ Red (alt+m to send immediately)` / `Press up to edit queued messages`, held `"Red"` until `StopWait` exited at its `~28 s` wait cap, and immediately started the next turn (`> Red` -> `Red noted.`).
- **Late-click check (`43.9 s`):** A board reply sent manually `43.9 s` after `Stop` (after the `28 s` `StopWait` cap expired) stayed `queued` (`line: "nextTurn"`), confirming `agy` has no idle door once `Stop` completes.

## Decision & remaining scope (B1 / Q3)

- **30 s cap & conservative route rationale:** Because `agy` `Stop` hook stdin exposes no field indicating queued TUI input (`▸ ... (alt+m to send immediately)`), extending `StopWait` to 10 minutes would delay normal TUI `Enter` submissions for up to 10 minutes and risk two-answer races (`StopWait` delivering a board answer right before the user's queued `Enter` runs). Keeping `StopWait` at `30 s` (`28 s` internal cap) and `hooks/receivers/hook-mailbox-antigravity.ts` conservative (`nextTurn`) delivers replies in `~6 s` within the wait window without long TUI lockouts, while leaving `Q3` / `--wait-message` visible for 0.27.0.
- **Out of scope for #1841:** Antigravity 2.0 desktop app wake rows (`hooks/antigravity-sidecar.ts` / PR #1612).

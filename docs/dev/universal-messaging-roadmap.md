# Universal Cross-Agent & Cross-Surface Messaging Roadmap

This document is the repository-tracked architecture, execution map, and coordinator handover guide for bidirectional messaging across all 12 Agent Board ecosystems (CLI, Desktop App, IDE, Chat Gateway, and Web Chat). Keeping this specification in `docs/dev/` and on the linked GitHub issues ensures any session or collaborator can take over QA, review, or coordination immediately if an active agent hits a usage or context limit (`docs/dev/team-process.md`: *"If it is not on the issue or the PR, it did not happen"*).

---

## 1. Product Focus & Core Architecture Invariants

### Primary Delivery Target: User-Led Cross-Agent Communication
The primary product goal is **a person communicating with different agents from one board** (`WenyuChiou` / `dot`). Broad autonomous agent-to-agent networking and unconstrained peer control are outside this immediate release.

Two evidence-backed host paths are targeted first:
1. **Claude Code**: In-process plugin hook/register (`[P1]`, `$.prompt.submit` / `$.clock.every`, tracked on #603).
2. **Codex CLI**: In-process turn-start hook (`[P1]`, `scripts/codex-local.ts`, tracked on #319).

All other surfaces retain an honest `Copy` or mailbox next-turn delivery fallback until separate, versioned host evidence is recorded and checked in.

### Non-Negotiable Safety & Protocol Invariants
1. **Zero external runtime dependencies**: `package.json` stays dependency-free. All HTTP, WebSocket, `fs.watch`, and `stdio` JSON-RPC 2.0 MCP framing use the Node standard library.
2. **Zero conversation scraping (`SECURITY.md`)**: Adapters never read `transcript_path` or saved chat history. Semantic acknowledgements come only from explicit tool/CLI calls (`board_ack`, `--message-ack`), owned in-memory SDK turn events, or single-turn hook response fields inspected in memory for a first-line `ACK <nonce>` and discarded immediately.
3. **Wait Cancellation, Pre-Claim Withdrawal, and Post-Claim Settlement**:
   - The atomic lock acquisition and disk commit in `claimMessages` (`queued` -> `uncertain`) is the single immutable point of no return.
   - **Wait cancellation (empty wait)**: When a caller aborts or times out a parked wait (`board_wait` / `--wait-message`) without a message having arrived, the wait is cleanly unregistered and aborted; any queued messages in the store remain untouched (`queued`) and unconsumed (matching #685).
   - **Pre-claim message withdrawal**: When the sender explicitly cancels or dismisses a message while still `queued` (before atomic claim wins), the message transitions to `rejected` with `error: 'DISMISSED'` / `'CANCELLED'`. Text is dropped, hash is preserved, and target blocking is released immediately. It is never claimed by or delivered to any host.
   - **Post-claim cancellation / disconnect**: Once `queued` -> `uncertain` is committed to disk, a cancellation or disconnect **cannot** roll back the message to `queued` (violates strict no-replay). In accordance with the core `#388` contract (`hooks/messaging.ts:158–164`), the message remains in or transitions to `uncertain` with `error: 'DISMISSED'` / `'CANCELLED'`; target blocking is preserved until the message settles, is acknowledged, or reaches `OPEN_LIMIT_MS` (30 minutes). The message is **never** automatically re-injected on later turns.

| Scenario | Durable State | Waiter Cleanup | Target-Blocking Effect | No-Replay Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **Wait Cancellation (Empty Wait)** | `queued` (messages unaffected) | Waiter unregistered from `WaitManager` | Target unblocked; queued messages remain available | N/A (no claim occurred) |
| **Pre-Claim Message Withdrawal** | `rejected` (`error: 'DISMISSED'`) | Message-specific waiter notification aborted | Target unblocked immediately | Message permanently finished; never delivered |
| **Post-Claim Cancellation / Disconnect** | `uncertain` (`error: 'DISMISSED'`) | Transport process aborted/killed; waiter closed | Target remains blocked until settled/timeout | Strict no-replay; never automatically re-injected |

4. **Target Blocking, Transport Evidence & Semantic Acknowledgement**:
   - Retain `#388`'s target blocking: `claimMessages` blocks a target while an open message is `accepted` or `uncertain` (`hooks/messaging.ts:158–164`). This prevents out-of-order execution, split delivery, and race conditions.
   - **Receipt stages**:
     1. *Prepared envelope*: In-memory claim formed, nonce issued, prompt framed.
     2. *Transport write / `accepted`*: Child process spawned/hook returned 0, SDK turn accepted, or MCP tool call returned. Persists status as `accepted`; **target remains blocked**. This is strictly transport receipt evidence, **never** proof of model reading or semantic comprehension.
     3. *Semantic ACK / `acknowledged`*: Host agent issues `ACK <nonce>` or `board_ack` within the turn. Persists status as `acknowledged`; target unblocks.
     4. *Settled / queue release*: Message text dropped, hash preserved, pruned after retention period (`FINISHED_KEEP_MS`).
   - Retain current `HOP_LIMIT=2` across all roadmaps and briefs (#603, #319, #685, #686) and six-hex ACK token (`ACK <nonce>`). The 128-bit random framing boundary used to isolate delivered peer prompts is stored and verified as a distinct field (`framingNonce`), preventing truncation or collision with the 6-character ACK token.
5. **Trusted Session/Turn Enrollment & Capability Lease Lifecycle**:
   - A capability token is enrolled and bound by a trusted local launcher or host adapter to:
     - Message store path
     - Native agent name
     - OS PID and process creation time (verifying parent-child process relationship)
     - Canonical workspace path (`canonical(cwd)` matching `canonical(workspace)`)
     - Owner generation and trusted turn boundary
   - **Permitted rights**: `board_wait`, `board_ack`, `board_post` strictly within own assigned session and turn. Cannot impersonate other sessions, cannot grant tool permissions or bypass trust.
   - **Expiry / renewal**: Leases expire at the turn boundary or after 60 s inactivity.
   - **Revocation / reconnect**: Contested registration marks both sessions `contested`; capability lease is immediately revoked, falling back to honest `Copy` mode.
   - Model-supplied text, prompt arguments, and client JSON-RPC request IDs are **not** identity proof.
   - Callers without authenticated host binding fall back to restricted unprivileged mailbox/polling mode, and never receive the privileged two-waits-per-turn lease.
6. **Fail-open lifecycle hooks (`<= 120 ms` lock budget)**: Message store errors or lock contention inside a host lifecycle hook must be caught and ignored so progress reporting and user prompts never fail or time out.
7. **Preserve Codex `/hooks` command strings byte-for-byte**: Installed hook command strings in `hooks/local-agents.ts` must remain byte-identical so existing Codex `/hooks` trust hashes stay valid across upgrades.

---

## 2. Observable States & Latency Budgets

Keep visible state and latency distinct so an enqueue or delivery failure cannot hide behind model delay:
- **Sending**: Immediate local UI feedback (`< 500 ms`); no durable delivery claim.
- **Queued**: Mailbox transaction committed to disk; visible send status within **1–2 seconds**.
- **Board update**: Overall board state refreshes in **~2 seconds**.
- **Host accepted**: Bound host/adapter has supplied transport delivery proof (child process spawned/hook returned 0, SDK turn accepted). **Not proof that the model read or answered**.
- **Semantic ACK**: Correlated acknowledgement (`ACK <nonce>` or `board_ack`) from the intended session/turn.
- **Full reply**: Separately observed completion with its own independent model latency.
- **Bounded wait**: A parked `board_wait` call's 45 s limit is the **maximum empty wait**; an arriving event wakes it immediately rather than waiting for the timeout.

---

## 3. Adopted Architecture Decision Table

| Dimension | Adopted Decision & Technical Contract | Covered Boundaries & Failure Modes | Owning Slice & Artifact |
| :--- | :--- | :--- | :--- |
| **1. Delivery Goal & Two-Host Proof** | Primary target: user-led communication from one board. First two verified paths: **Claude Code** (`[P1]`) and **Codex** (`[P1]` turn-start). All other surfaces keep honest `Copy` / next-turn mailbox fallback until separate native evidence is checked in. | Distinguishes UI feedback (1–2s), board refresh (~2s), and model latency; prevents fabricated delivery claims. | `#687` Roadmap, `#603` Mailbox, `#319` Codex adapter |
| **2. Cancellation, Claim & Uncertainty** | Atomic claim commit (`queued -> uncertain`) is the single ordering boundary. Pre-claim cancel removes from queue; post-claim cancel records uncertain receipt, preserving **no-replay**. | Arrival races, disconnect after claim, timeout after claim, stale-waiter cleanup. | `#603` Mailbox state machine, `#685` MCP cancellation semantics |
| **3. Trusted Session/Turn Enrollment** | Local launcher/host binds capability to store path, native agent, PID/start time, canonical workspace path, owner generation, and turn boundary. Unbound callers fall back to restricted mailbox polling. | Forged identity claims, stale leases, cross-workspace leakage, restart/reconnect. | `#603` Contract, `#685` Lease manager |
| **4. Acceptance, Ordering & Compatibility** | Retains `#388` target blocking while messages are `accepted` or `uncertain`. `accepted` is transport evidence only. Keeps `HOP_LIMIT=2` and six-hex ACK token; 128-bit framing boundary is separate `framingNonce`. **DAG: `#365` unlocks only after `#388` + `#603` + `#319` merge.** | Out-of-order delivery, late/duplicate ACK, shared-file conflicts across `#319` and `#365`. | `#603` Core, `#319` Codex, `#365` Antigravity/Gemini, `#687` DAG |
| **5. Capability Evidence & Visible Latency** | Surfaces explicitly tiered as `Proposed`, `Implemented`, or `Verified`. Target 1–2s visible send status, ~2s board update, separate from host ACK and model reply. Empty wait 45s max; prompt wake on event. | Prevents stacked 2s polling loops; surfaces real failure states. | `#687` Matrix, `#685` Waiter, `#365` Card gating |

---

## 4. Five Delivery Primitives & Four Honest UI Tiers

### Five Host Primitives (`[P1]`–`[P5]`)
- **`[P1]` In-Process SDK Live Push**: Plugins already loaded inside the host runtime wake idle sessions directly (`Claude Code` `$.clock.every` + `$.prompt.submit` without `asUser`; `Codex` daemon `turn/start`; `OpenCode` `client.session.promptAsync`; `DeepSeek Harness` Cordis `agent.followup` on root agents; `OpenClaw` Gateway RPC `chat.send` with `idempotencyKey` and `allowConversationAccess: false`).
- **`[P2]` Reactive Background Task Wakeup (`--wait-message`)**: For `Antigravity` 2.0 Desktop App, Antigravity IDE, and `agy` TUI (`WaitMsBeforeAsync: 500, IsDaemon: false`). Parks on `fs.watch` at 0% CPU and 0 token cost; claims an arriving message, prints the nonce-fenced envelope, and exits `0` to trigger Antigravity's native reactive turn wakeup.
- **`[P3]` Zero-Dependency `stdio` MCP Parked Waiter (`--mcp` / `board_wait`)**: Exposes `board_status`, `board_inbox`, `board_ack`, `board_send`, and `board_wait`. `board_wait` enforces a **45 s single-call ceiling** (safe under 60 s Cursor IDE / Claude Desktop MCP timeouts), emits `notifications/progress` every 15 s, caps consecutive waits at **2 per turn** (90 s max), and **never pre-claims** while waiting so `Esc` cancellation or timeout leaves messages `queued`.
- **`[P4]` Turn-Boundary Continuation**: Active turns pick up queued messages before stopping via host continuation hooks (`Codex` / `Grok Build` / `Muse Code` `Stop` `{"decision":"block"}`; `Antigravity` `Stop` `{"decision":"continue"}` and `PreInvocation`; `Cursor` `stop` `{"followup_message":...}`; `Gemini CLI` `AfterAgent` `{"decision":"deny"}`).
- **`[P5]` Zero-Paste-Box Assisted Relay**: For `dot` and cloud web chats (`Claude.ai`, `ChatGPT`, `Gemini Web`, `DeepSeek Web`, `Grok Web`), using short-lived scoped import capabilities, `#import=` top-level navigation, and one-click clipboard import without a permanent textarea (`#546`, `#561`).

### Four Honest UI Delivery Tiers
| Tier | Condition | Card Action & Copy |
| :--- | :--- | :--- |
| **Tier 1 — Live Push** | Active verified lease (`[P1]`, Codex daemon `turn/start`, `--wait-message`, or parked `board_wait`) | `Send to <Agent>` (wakes within seconds) |
| **Tier 2 — Turn-Boundary** | Target session `working` with supported continuation hook (`[P4]`) | `Send at step end` (cancellable while `queued`) |
| **Tier 3 — Next-Turn Mailbox** | Idle without live waiter, but prompt/start hook or MCP `board_inbox` installed | `Queue for next turn` + `Copy` side by side (never labelled `Delivered` before host confirmation) |
| **Tier 4 — Assisted Relay** | Web chats (`dot`), unsupported/unconnected surfaces, ended sessions without `--allow-resume`, or `--lan` | `Copy` / `Copy relay envelope` |

---

## 5. All 12 Ecosystems × Surface Coverage Matrix

| # | Ecosystem | Surfaces Covered | Status | Tier 1 (Idle Wake) | Tier 2 (Busy Continuation) | Tier 3 (Next-Turn) | Outbound & Receipt |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Claude Code & Desktop** | CLI (`Code` >= 0.2.29); Desktop `Chat` | **Proposed** | `Code`: `[P1]` `$.prompt.submit` (gated by #603); `Chat`: `[P3]` `board_wait` (blocked by #685) | `Code`: `receive: false` until `turn.complete` | Plugin / `board_inbox` | Native pane + MCP `board_send` / `turn.complete` first-line `ACK` or `board_ack` |
| 2 | **Codex** | CLI (Codex CLI >= 0.1.0); Daemon; Desktop App | **Proposed** | CLI: turn-start `--codex-report` / stdin envelope (gated by #388 / #319); Daemon: `turn/start` (blocked by #318); App: `[P3]` (blocked by #685) | `Stop` `{"decision":"block"}` | `SessionStart` + `UserPromptSubmit` | MCP `board_send` or `--send` / `Stop` first-line `ACK` or `board_ack` |
| 3 | **Antigravity** | 2.0 Desktop App, IDE, `agy` TUI / Stream CLI, SDK | **Proposed** | App/IDE/TUI: `[P2]` `--wait-message` (gated by #365 / #685); Stream: `stdin` | `PreInvocation` + `Stop` `{"decision":"continue"}` | `SessionStart` + `PreInvocation` (Gated: `HAS_ANTIGRAVITY_STEP_END_RECORD=false`) | `mcp_config.json` MCP + `--send` + optional Sidecar link |
| 4 | **OpenCode** | CLI TUI, Desktop App, Web UI | **Proposed** | `[P1]` `client.session.promptAsync` + `[P3]` (blocked by #686) | `session.idle` plugin dispatch | Plugin / `board_inbox` | Plugin `agent_board_send` & `agent_board_ack` (`context.sessionID`) |
| 5 | **Cursor** | Cursor IDE (Composer), `cursor-agent` CLI | **Proposed** | `[P3]` `board_wait` (45 s, blocked by #685) | `stop` `{"followup_message":...}` (gated by #319) | `sessionStart` + `board_inbox` (never `beforeSubmitPrompt`) | `~/.cursor/mcp.json` MCP + `afterAgentResponse` first-line `ACK` |
| 6 | **Grok Build** | CLI (`grok`) | **Proposed** | `[P3]` `board_wait` (45 s); ended opt-in `--allow-resume` | `Stop` `{"decision":"block"}` (gated by #319) | MCP `board_inbox` | `~/.grok/config.toml` MCP + `Stop` `lastAssistantMessage` first-line `ACK` |
| 7 | **Muse Code** | CLI (`muse`) | **Proposed** | `[P3]` `board_wait` (45 s, blocked by #685) | `Stop` `{"decision":"block"}` (gated by #319) | `SessionStart` + `UserPromptSubmit` (`schema_version: 1`) | `~/.config/muse/settings.json` MCP |
| 8 | **Hermes Agent** | CLI, Chat Gateway (Telegram / Discord / Slack) | **Proposed** | Gateway hook queue receiver + `[P3]` `board_wait` (blocked by #233) | `pre_llm_call` + `post_llm_call` | `pre_llm_call` + MCP | MCP `board_send` / `board_ack` + `post_llm_call` |
| 9 | **OpenClaw** | Gateway, WebChat, Desktop Control UI | **Proposed** | `[P1]` Gateway RPC `chat.send` (`idempotencyKey`, local/WebChat only, blocked by #686) | `registerAgentEventSubscription` | `agent_board_inbox` | `api.registerTool` (`allowConversationAccess: false`) |
| 10 | **DeepSeek Harness** | Cordis CLI, TUI, Desktop, Web | **Proposed** | `[P1]` `agent.followup` (`!agent.parentAgent`, blocked by #686) | `ctx.on('agent/status')` -> `idle` | `ctx.tools` / MCP | `ctx.tools` `send` & `ack` (`ToolExecutionInput.agent`) |
| 11 | **Legacy Gemini CLI** | CLI (`gemini`) | **Proposed** | `[P3]` `board_wait` (45 s, blocked by #685) | `AfterAgent` `{"decision":"deny"}` (gated by #365) | `SessionStart` + `BeforeAgent` | `~/.gemini/settings.json` MCP + `AfterAgent` first-line `ACK` |
| 12 | **`dot` & Web Chats** | Claude.ai, ChatGPT, Gemini Web, DeepSeek Web, Grok Web | **Proposed** | Honest Tier 4 (no unsolicited wake) | Parsed on block import | One-click `<<<board-message <nonce>>>>` copy | Scoped `#import=` link + zero-paste-box clipboard import (`#561`) |

---

## 6. Phased PR Execution Table & File Boundaries

Every slice stays focused (`<= 500` changed lines excluding generated bundles and changelog fragments) and owns disjoint primary files within each parallel wave:

| Phase / Slice | Issue / PR | Assigned Executor | Label State | Primary Files (Non-Colliding Within Wave) | Unlocks When Merged |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phase 1A** | `#315` (PR `#388`) | `claude` / `codex` / `antigravity` | In CI / Ready | `hooks/messaging.ts`, `scripts/board-messaging.ts`, `scripts/message-store-claim.ts`, `scripts/board-serve.ts`, `scripts/board-cli.ts` | `#603`, `#317`, `#316`, `#318` |
| **Phase 1B** | `#603` | **`dot`** (`for-dot`) | `blocked` -> `ready` after `#388` | `hooks/hook-safety.ts`, `hooks/hook-messages.ts`, `scripts/codex-local.ts` | `#319`, `#685`, `#686`, `#233` |
| **Phase 1C** | `#317` | **`muse`** (`for-dot`) | `blocked` -> `ready` after `#388` | `hooks/cli-send.ts`, `hooks/board.ts`, `scripts/board-cli.ts`, `tests/cli-send.test.mjs` | `#232` |
| **Phase 2A** | `#319` | **`dot`** (`for-dot`) | `blocked` -> `ready` after `#603` | `hooks/hook-messages.ts`, `scripts/codex-local.ts` (Codex/Grok/Muse `Stop` `block` + Cursor `stop`) | `#365` (Phase 2B) |
| **Phase 2B** | `#365` | **`muse`** (`for-dot`) | `blocked` -> `ready` after **`#388`, `#603`, and `#319`** | `hooks/hook-messages.ts`, `scripts/codex-local.ts` (Antigravity `Stop`/`PreInvocation` + Gemini `AfterAgent`) | Full Tier 2 Antigravity/Gemini |
| **Phase 3A** | `#685` | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#603` | `hooks/mcp-tools.ts`, `scripts/board-mcp.ts`, `scripts/board-cli.ts` (`--mcp`, `--wait-message`), `hooks/connect-pure.ts` | Universal Desktop/IDE Tier 1 |
| **Phase 3B-1** | `#316` | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#388` | `hooks/receiver.ts`, `hooks/register.tsx`, `hooks/serve.ts`, string tables | Claude Code Tier 1 |
| **Phase 3B-2** | `#318` | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#388` | `scripts/codex-receiver.mjs`, `hooks/codex.ts` | Codex Daemon Tier 1 |
| **Phase 3C-1** | `#686` | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#603` | `hooks/local-agents.ts` (`opencodePlugin`), `hooks/portable-agents.ts` (DeepSeek, OpenClaw) | OpenCode/DeepSeek/OpenClaw Tier 1 |
| **Phase 3C-2** | `#233` | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#603` | `hooks/local-agents.ts` / `scripts/hermes-session-connector.mjs`, `tests/e2e/l3b-messaging.test.mjs` | Hermes L3b parity |
| **Phase 3D** | `#232` (Bug PR) | **`claude`** (`for-agent`) | `blocked` -> `ready` after `#317` | `hooks/pane.tsx`, `hooks/board.ts`, `scripts/board-cli.ts`, `tests/e2e/l3b-messaging.test.mjs` | Cross-surface receipt parity |
| **Phase 4A** | `#561` | **`claude`** (`for-agent`) | `ready` (`for-agent`) | `docs/validation/*-web-chat-relay.md`, `hooks/serve.ts`, `scripts/board-serve.ts` | `dot` & Web-Chat zero-paste-box |

---

## 7. QA Acceptance & Coordinator Handover Playbook

If the active QA/coordinator agent (`antigravity`) reaches its session or rate limit, **any maintainer, collaborator, or `claude` / `codex` session** can resume seamlessly with the following steps:

### Step 1 — Inspect Live Queue & CI State
```sh
node scripts/review-queue.mjs
gh pr list --repo WenyuChiou/agent-board --state open --json number,title,isDraft,headRefName,headRefOid
gh issue list --repo WenyuChiou/agent-board --state open --label for-dot --json number,title,labels
gh issue list --repo WenyuChiou/agent-board --state open --label for-agent --json number,title,labels
```

### Step 2 — Technical QA Checklist on Incoming PRs (`dot`, `muse`, `claude`)
1. **Scope & B3 rule**: Verify the diff touches only files needed by its listed issues, includes `changelog.d/<issue>-<slug>.md` with exact covering test titles, and never mixes a bug fix (`#232`) into a feature PR.
2. **Bundle rebuilds (`brief-rules.md` #7, `AGENTS.md` Checks)**: If a `for-dot` PR touched files compiled into `hooks/board-script.ts` and wrote `"maintainer rebuilds at merge"` under Checks instead of running Bun 1.4.2, check out the PR branch in a clean worktree, merge `origin/main` only if conflicting, and run `npx --yes bun@1.4.2 scripts/build-board.ts` (released-file generation via `scripts/build-released.ts` applies only to release tags).
3. **Sequential local verification (`brief-rules.md` #10, `AGENTS.md` Checks)**: Run **one test command at a time** in an isolated temporary home:
   - Run touched Node test files (`node --test <touched-test-file>`).
   - If TS/TSX test files changed, run `claude plugin validate --strict .` and `claude plugin test .` once, alone.
   - Run `node scripts/pr-check.mjs --pr <PR>` and verify `preflight.mjs` output is pasted under `## Checks`.
4. **Governance Rule R2 (`docs/dev/RULES.md` #R2 — Nobody approves their own work)**:
   - Remember: any agent that wrote part of a PR **or wrote its brief** counts as an author of that PR (`team-process.md` line 58, `RULES.md` line 17).
   - Because `antigravity` authored the briefs on `#603`, `#317`, `#319`, `#365`, `#685`, `#316`, `#318`, `#686`, `#233`, `#232`, and `#561`, `antigravity` performs technical QA, bundle rebuilds, and `Review: REQUEST CHANGES <full sha>` when fixes are needed, while the formal `Review: APPROVE <full sha> by <reviewer>` must come from an independent collaborator (`SUPERD6`, `RyanGosling0508`), the owner (`WenyuChiou`), or an independent reviewer session that did not author the PR or its brief.

### Step 3 — Automatic Label Unlocks After Each Merge
Immediately after squash-merging an upstream PR (`gh pr merge <PR> --squash --match-head-commit <sha>`) and posting closing verification evidence on its issue:

- **When `#388` (`#315`) merges**, unlock Phase 1B, Phase 1C, Phase 3B-1, and Phase 3B-2:
  ```sh
  gh issue edit 603 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 317 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 316 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 318 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  ```
- **When `#603` (Phase 1B) merges**, unlock Phase 2A, Phase 3A, Phase 3C-1, and Phase 3C-2:
  ```sh
  gh issue edit 319 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 685 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 686 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  gh issue edit 233 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  ```
- **When `#319` (Phase 2A) merges**, unlock Phase 2B (`#365`):
  ```sh
  gh issue edit 365 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  ```
- **When `#317` (Phase 1C) merges**, unlock Phase 3D (`#232`):
  ```sh
  gh issue edit 232 --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
  ```

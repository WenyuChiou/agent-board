# Universal Cross-Agent & Cross-Surface Messaging Roadmap

This document is the repository-tracked architecture, execution map, and handover guide for bidirectional messaging across all 12 Agent Board ecosystems (CLI, Desktop App, IDE, Chat Gateway, and Web Chat). Keeping this specification in `docs/dev/` and on the linked GitHub issues ensures any session or collaborator can take over QA, review, or coordination immediately if an active agent hits a usage or context limit (`docs/dev/team-process.md`: *"If it is not on the issue or the PR, it did not happen"*).

---

## 1. Product Focus & Core Architecture Invariants

### Primary Delivery Target: User-Led Cross-Agent Communication
The primary product goal is **a person communicating with different agents from one board** (`WenyuChiou` / `dot`). Broad autonomous agent-to-agent networking and unconstrained peer control are outside this immediate release.

Two evidence-backed host paths are targeted first:
1. **Claude Code**: In-process plugin receiver (`[P1]`, `$.clock.every` + `$.prompt.submit` in `hooks/receiver.ts` / `hooks/register.tsx`, tracked on #316).
2. **Codex CLI**: Native prompt/turn-start hook next-turn delivery (`scripts/codex-local.ts`, tracked on #603), step-end `Stop` continuation (tracked on #319), and shared-daemon `turn/start` live push (`[P1]`, tracked on #318).

All other surfaces retain an honest `Copy` or mailbox next-turn delivery fallback until separate, versioned host evidence is recorded and checked in.

### Non-Negotiable Safety & Protocol Invariants
1. **Zero external runtime dependencies**: `package.json` stays dependency-free. All HTTP, WebSocket, `fs.watch`, and `stdio` JSON-RPC 2.0 MCP framing use the Node standard library.
2. **Zero conversation scraping (`SECURITY.md`)**: Adapters never read `transcript_path` or saved chat history. Semantic acknowledgements come only from explicit tool/CLI calls (`board_ack`, `--message-ack`), owned in-memory SDK turn events, or single-turn hook response fields inspected in memory for a first-line `ACK <nonce>` and discarded immediately.
3. **Wait Cancellation, Pre-Claim Withdrawal, and Post-Claim Settlement**:
   - The atomic lock acquisition and disk commit in `claimMessages` (`queued` -> `uncertain`) is the single immutable point of no return.
   - **Wait cancellation (empty wait)**: When a caller aborts or times out a parked wait (`board_wait` / `--wait-message`) without a message having arrived, the wait is cleanly unregistered and aborted; any queued messages in the store remain untouched (`queued`) and unconsumed (matching #685).
   - **Pre-claim message withdrawal**: When the sender explicitly cancels or dismisses a message while still `queued` (before atomic claim wins), the message transitions to `rejected` with `error: 'DISMISSED'` / `'CANCELLED'`. Text is dropped, hash is preserved, and target blocking is released immediately. It is never claimed by or delivered to any host.
   - **Post-claim cancellation / disconnect**: Once `queued` -> `uncertain` is committed to disk, a cancellation or disconnect **cannot** roll back the message to `queued` (violates strict no-replay). In accordance with the core `#388` contract (`hooks/messaging.ts:158–164`), the message remains in or transitions to `uncertain` with `error: 'CANCELLED'`; target blocking is preserved until the message settles, is acknowledged, or reaches `OPEN_LIMIT_MS` (30 minutes) (a target with an ACK channel; a hook-only target is not held, invariant 4). The message is **never** automatically re-injected on later turns.
   - **Dismissing a claimed message** (owner decision, 2026-11-02, [on #728](https://github.com/WenyuChiou/agent-board/pull/728#issuecomment-6592764318)): `#388`'s behaviour is the contract. An `accepted` or `uncertain` message becomes final `uncertain` with `error: 'DISMISSED'`, and the target is free for the next message (`dismissMessage` in `hooks/messaging.ts`). It is never automatically re-injected.

| Scenario | Durable State | Waiter Cleanup | Target-Blocking Effect | No-Replay Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **Wait Cancellation (Empty Wait)** | `queued` (messages unaffected) | Waiter unregistered from `WaitManager` | Unchanged (existing open message blocking preserved; queued messages remain available) | N/A (no claim occurred) |
| **Pre-Claim Message Withdrawal** | `rejected` (`error: 'DISMISSED'`) | Message-specific waiter notification aborted | Target unblocked immediately | Message permanently finished; never delivered |
| **Post-Claim Cancellation / Disconnect** | `uncertain` (`error: 'DISMISSED'`); an `accepted` message that is dismissed also becomes `uncertain` | Transport process aborted/killed; waiter closed | Target remains blocked until settled/timeout, except after a dismiss, which frees it (invariant 3); a hook-only target is not held (invariant 4) | Strict no-replay; never automatically re-injected |

4. **Target Blocking, Transport Evidence & Semantic Acknowledgement**:
   - Retain `#388`'s target blocking: `claimMessages` blocks a target while an open message is `accepted` or `uncertain` (`hooks/messaging.ts:158–164`). This prevents out-of-order execution, split delivery, and race conditions.
   - **A hook-only target is not held.** A target that has no ACK channel (a next-turn hook with no `board_ack`, Tier 3) can never answer `ACK <nonce>`, so the rule above would let it take one message per `OPEN_LIMIT_MS` (30 minutes). For such a target the hook's completed write is the delivery: the message is recorded `accepted` and does not block the target. Order still holds: `claimMessages` hands over one message per claim, the oldest queued first, so the target gets one message per turn in the order they were sent. A target with an ACK channel keeps the blocking rule. Owner: #603.
   - **Receipt stages**:
     1. *Prepared envelope*: In-memory claim formed, nonce issued, prompt framed.
     2. *Completed transport write / `accepted`*: External transport write verified complete (stdout pipe flushed, SDK turn submitted, or MCP tool call returned; process spawn alone is insufficient). Persists status as `accepted`; **target remains blocked** if it has an ACK channel, while a hook-only target is not held (invariant 4). This is strictly transport receipt evidence, **never** proof of model reading or semantic comprehension.
     3. *Semantic ACK / `acknowledged`*: Host agent issues `ACK <nonce>` or `board_ack` within the turn. Persists status as `acknowledged`; target unblocks.
     4. *Settled / queue release*: Message text dropped, hash preserved, pruned after retention period (`FINISHED_KEEP_MS`).
   - Retain current `HOP_LIMIT=2` across all roadmaps and briefs (#603, #319, #685, #686) and six-hex ACK token (`ACK <nonce>`). The fence that isolates a delivered peer prompt is `<<<AB-<nonce>`, which reuses the same six-hex nonce, as in `#388`.
5. **Trusted Session/Turn Enrollment & Capability Lease Lifecycle**:
   - A capability token is enrolled and bound by a trusted local launcher or host adapter to:
     - Message store path
     - Native agent name
     - OS PID and process creation time (verifying parent-child process relationship)
       - Implementation risk (#685): on Windows, looking up a parent PID's creation time without dependencies may exceed the hook budget. #685 must measure it; if the binding cannot be verified within budget, the caller falls back to restricted mailbox mode and never receives the lease.
     - Canonical workspace path (`canonical(cwd)` matching `canonical(workspace)`)
     - Owner generation and trusted turn boundary
   - **Permitted rights**: `board_wait`, `board_ack`, `board_post` strictly within own assigned session and turn. Cannot impersonate other sessions, cannot grant tool permissions or bypass trust.
   - **Expiry / renewal**: Leases expire at the turn boundary or after 60 s inactivity. A parked `board_wait` (including its 15 s `notifications/progress`) counts as activity, so the second consecutive wait in the same turn stays valid. This 60 s lease is the MCP capability lease that #721 adds, under its own name. It is not #388's 15 s `LEASE_MS` in `scripts/board-messaging.ts`, which is the receiver connection lease renewed on every poll.
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
- **Host accepted**: Bound host/adapter has verified completed transport write (stdout pipe flushed, SDK turn submitted, or MCP tool call returned; child process spawn alone is insufficient). Persists status as `accepted`; target remains blocked unless it is a hook-only target (invariant 4). **Not proof that the model read or answered**.
- **Semantic ACK**: Correlated acknowledgement (`ACK <nonce>` or `board_ack`) from the intended session/turn.
- **Full reply**: Separately observed completion with its own independent model latency.
- **Bounded wait**: A parked `board_wait` call's 45 s limit is the **maximum empty wait**; an arriving event wakes it immediately rather than waiting for the timeout.

---

## 3. Adopted Architecture Decision Table

| Dimension | Adopted Decision & Technical Contract | Covered Boundaries & Failure Modes | Owning Slice & Artifact |
| :--- | :--- | :--- | :--- |
| **1. Delivery Goal & Two-Host Proof** | Primary target: user-led communication from one board. First two targeted live-push paths: **Claude Code** (`[P1]`, #316) and **Codex** (`[P1]` daemon `turn/start`, #318); #603 provides Tier 3 next-turn delivery and #319 provides Tier 2 step-end continuation. All other surfaces keep honest `Copy` / next-turn mailbox fallback until separate native evidence is checked in. | Distinguishes UI feedback (1–2s), board refresh (~2s), and model latency; prevents fabricated delivery claims. | `#687` Roadmap, `#316` Claude receiver, `#318` Codex daemon, `#603` Hook mailbox, `#319` Codex step-end |
| **2. Cancellation, Claim & Uncertainty** | Atomic claim commit (`queued -> uncertain`) is the single ordering boundary. Pre-claim cancel removes from queue; post-claim dismiss leaves the message `uncertain` (also from `accepted`) and frees the target, preserving **no-replay**. | Arrival races, disconnect after claim, timeout after claim, stale-waiter cleanup. | `#603` Mailbox state machine, `#685` MCP cancellation semantics |
| **3. Trusted Session/Turn Enrollment** | Local launcher/host binds capability to store path, native agent, PID/start time, canonical workspace path, owner generation, and turn boundary. Unbound callers fall back to restricted mailbox polling. | Forged identity claims, stale leases, cross-workspace leakage, restart/reconnect. | `#603` Contract, `#685` Lease manager |
| **4. Acceptance, Ordering & Compatibility** | Retains `#388` target blocking while messages are `accepted` or `uncertain`, except for a hook-only target with no ACK channel (invariant 4). `accepted` is transport evidence only. Keeps `HOP_LIMIT=2` and six-hex ACK token; the fence reuses the six-hex nonce. **DAG: `#365` unlocks only after `#388` + `#603` + `#319` merge.** | Out-of-order delivery, late/duplicate ACK, shared-file conflicts across `#319` and `#365`. | `#603` Core, `#319` Codex, `#365` Antigravity/Gemini, `#687` DAG |
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
| 1 | **Claude Code & Desktop** | CLI (`Code` >= 0.2.29); Desktop `Chat` | **Proposed** | `Code`: `[P1]` `$.prompt.submit` (gated by #316); `Chat`: `[P3]` `board_wait` (blocked by #685) | `Code`: `receive: false` until `turn.complete` | Plugin / `board_inbox` | Native pane + MCP `board_send` / `turn.complete` first-line `ACK` or `board_ack` |
| 2 | **Codex** | CLI (Codex CLI >= 0.1.0); Daemon; Desktop App | **Proposed** | Daemon: `[P1]` `turn/start` (blocked by #318); App: `[P3]` (blocked by #685) | `Stop` `{"decision":"block"}` (gated by #319) | CLI: `SessionStart` + `UserPromptSubmit` next-turn mailbox (gated by #388 / #603) | MCP `board_send` or `--send` / `Stop` first-line `ACK` or `board_ack` |
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

Once #720 merges, the status of each surface comes from its receiver's record and the table in `docs/MESSAGING.md` is generated from them (section 8); this matrix then links there instead of carrying its own status.

---

## 6. Phased PR Execution Table & File Boundaries

The work runs in four waves. A wave starts when the merges it names are in, not when the whole wave before it ends. Within a wave, slices own disjoint primary files so they can run at the same time. Every slice stays focused (`<= 500` changed lines, generated bundles excluded).

The lane is the suggested executor. It is not a claim: whoever takes a `ready` issue assigns themselves ([RULES.md R4](RULES.md#r4-one-issue-one-owner)), and an issue idle for 24 hours goes back to `ready`. `dot` and `muse` work on GitHub only, so slices that need an app installed (the spikes, live runs) go to a local agent.

### Wave 0: now

| Slice | Issue / PR | Lane | Primary files | Unlocks |
| :--- | :--- | :--- | :--- | :--- |
| Message store | `#315` (PR `#388`) | its current authors; `dot` pushes its pending patch first | `hooks/messaging.ts`, `scripts/board-messaging.ts`, `scripts/message-store-claim.ts`, `scripts/board-serve.ts`, `scripts/board-cli.ts` | wave 1 |
| Web-chat relay | `#561` | `claude` (assigned) | `docs/validation/*-web-chat-relay.md`, `hooks/serve.ts`, `scripts/board-serve.ts` | `dot` and web chats, Tier 4 |
| Vendor API spikes | step 1 of `#722`, `#724`, `#725`, `#726` | a local agent with that app installed | `docs/validation/<date>-<host>-spike.md` | the slice that uses that API |

A spike is half a day: on a machine with the app, call the one API the slice depends on (Antigravity's wakeup on a background command exiting 0; OpenCode `client.session.promptAsync`; DeepSeek `agent.followup`; OpenClaw `chat.send`) and record the version, OS, call and result. A spike that fails stops its slice with a `Question:` before any code is written. Claude Code needs none: `$.prompt.submit` already passed as L1 in [2026-10-20-send-spikes.md](../validation/2026-10-20-send-spikes.md), so #316 starts from that record.

### Wave 1: after `#388` merges

| Slice | Issue | Lane | Primary files | Unlocks |
| :--- | :--- | :--- | :--- | :--- |
| Hook mailbox | `#603` | `codex` | `hooks/hook-safety.ts`, `hooks/hook-messages.ts`, `scripts/codex-local.ts` | wave 2 |
| Receiver records | `#720` | `claude` | `scripts/message-client.mjs` (record type), `scripts/messaging-matrix.mjs`, `docs/MESSAGING.md` (generated table) | `#724`, `#725`, `#726`; `#316` and `#318` add a record |
| Claude Code receiver | `#316` | `claude` | `hooks/receiver.ts`, `hooks/register.tsx`, `hooks/serve.ts`, string tables | Claude Code Tier 1 |
| Codex daemon receiver | `#318` | `antigravity` | `scripts/codex-receiver.mjs`, `hooks/codex.ts` | Codex daemon Tier 1 |
| Agent `--send` | `#317` | `dot` | `hooks/cli-send.ts`, `hooks/board.ts`, `scripts/board-cli.ts`, `tests/cli-send.test.mjs` | `#232` |

`#720` merges before `#316` and `#318` go Ready; they start at the same time and merge `main` once it is in.

### Wave 2: after `#603` merges

| Slice | Issue | Lane | Primary files | Unlocks |
| :--- | :--- | :--- | :--- | :--- |
| Codex step end | `#319` | `muse` | `hooks/hook-messages.ts`, `scripts/codex-local.ts` (Codex, Grok, Muse `Stop` and Cursor `stop`) | `#365` |
| Antigravity and Gemini step end | `#365` | `muse`, after `#319` and the Antigravity spike | `hooks/hook-messages.ts`, `scripts/codex-local.ts` (Antigravity `Stop`/`PreInvocation`, Gemini `AfterAgent`) | Tier 2 for Antigravity and Gemini |
| MCP server (`#685` part 1 of 3) | `#721` | `claude` | `hooks/mcp-tools.ts`, `scripts/board-mcp.ts`, `scripts/board-cli.ts` (`--mcp`), peer guardrails in `hooks/messaging.ts` | `#722` |
| Parked waiters (`#685` part 2 of 3) | `#722` | `codex`, after `#721` | `scripts/board-mcp.ts` (waiter), `scripts/board-cli.ts` (`--wait-message`) | Desktop and IDE Tier 1 |
| MCP config entries (`#685` part 3 of 3) | `#723` | `antigravity` | `hooks/connect-pure.ts`, `scripts/setup.ts` | MCP for six hosts |
| OpenCode receiver (`#686`) | `#724` | the agent that ran its spike | `hooks/receivers/opencode.ts`, one import line in `hooks/local-agents.ts` | `#233`, OpenCode Tier 1 |
| DeepSeek receiver (`#686`) | `#725` | the agent that ran its spike | `hooks/receivers/deepseek.ts`, one import line in `hooks/portable-agents.ts` | DeepSeek Tier 1 |
| OpenClaw receiver (`#686`) | `#726` | the agent that ran its spike | `hooks/receivers/openclaw.ts`, one import line in `hooks/portable-agents.ts` | OpenClaw Tier 1 |

`#685` and `#686` stay open as parent issues and close when their last part merges. Each `#686` receiver lives in its own file, so the three touch only one import line of a shared file; that one-line conflict is fixed by merging `main`.

### Wave 3: last

| Slice | Issue | Lane | Primary files | Starts after |
| :--- | :--- | :--- | :--- | :--- |
| Hermes receiver | `#233` | `claude` | `hooks/local-agents.ts`, `scripts/hermes-session-connector.mjs`, `tests/e2e/l3b-messaging.test.mjs` | `#603` and `#724` |
| Receipts on every surface | `#232` (bug) | `claude` | `hooks/pane.tsx`, `hooks/board.ts`, `scripts/board-cli.ts`, `tests/e2e/l3b-messaging.test.mjs` | `#317` |

`#724` and `#233` both touch `hooks/local-agents.ts`, so `#233` starts from `main` after `#724` merges (or merges `main` into an existing draft branch, without rebasing). Neither changes installed Codex hook command strings (invariant 7).

---

## 7. QA Acceptance & Handover Playbook

Any agent or person who is not an author of a slice may run its QA; `antigravity` did it first. If one stops, the next takes over with these steps.

### Step 1 — Inspect Live Queue & CI State
```sh
node scripts/review-queue.mjs
gh pr list --repo WenyuChiou/agent-board --state open --json number,title,isDraft,headRefName,headRefOid
gh issue list --repo WenyuChiou/agent-board --state open --milestone "0.25.0 Send to Claude, hand-off, versions and doctor" --json number,title,labels,assignees
```

### Step 2 — Technical QA Checklist on Incoming PRs
1. **Scope**: the diff touches only the files its issue lists, has a title that can serve as its changelog line (pull requests add no `changelog.d` fragment since #719), and never mixes a bug fix (`#232`) into a feature PR.
2. **Bundle rebuilds**: if a PR from `dot` or `muse` touched files compiled into `hooks/board-script.ts` and wrote `"maintainer rebuilds at merge"` under Checks, check out the branch in a clean worktree and run `npx --yes bun@1.4.2 scripts/build-board.ts`.
3. **Local verification, one command at a time** in an isolated temporary home: the touched Node test files (`node --test <file>`); `claude plugin validate --strict .` and `claude plugin test .` once, alone, if TS/TSX test files changed; and `node scripts/pr-check.mjs --pr <PR>`.
4. **Who approves** ([RULES.md R2](RULES.md#r2-nobody-approves-their-own-work)): the authors of a slice are its executor and whoever wrote its brief. `antigravity` wrote the briefs of `#603`, `#316`, `#317`, `#318`, `#319`, `#365`, `#685`, `#686`, `#233`, `#232` and `#561`; `claude (cloud)` wrote `#720` to `#726`. The `Review: APPROVE <full sha> by <name>` comes from anyone else: another agent or session, a collaborator, or the owner. An author may still run QA and write `Review: REQUEST CHANGES`.

### Step 3 — Label Unlocks After Each Merge
After a merge, remove `blocked` and add `ready` on each issue the merge unlocks, once everything in its row has merged:

Before each `--add-label ready` below, post the issue's `Ready check:` comment ([RULES.md, R4](RULES.md#r4-one-issue-one-owner)); the merge settles only what the issue waits on, not the other three points.

| When this merges | Unlock |
| :--- | :--- |
| `#388` (`#315`) | `#603`, `#720`, `#316`, `#318`, `#317` |
| `#603` | `#319`, `#721`, `#723`; and `#724`, `#725`, `#726` once `#720` is in and the vendor's spike passed |
| `#319` | `#365`, once the Antigravity spike passed |
| `#721` | `#722` |
| `#724` | `#233` |
| `#317` | `#232` |

```sh
gh issue edit <N> --repo WenyuChiou/agent-board --remove-label blocked --add-label ready
```

---

## 8. When a Surface Counts as Done

A surface's status in the matrix moves only on evidence:

- **Proposed**: no merged receiver.
- **Implemented**: the receiver is merged with synthetic tests, named by their test titles in the PR.
- **Verified**: a dated live run is recorded in `docs/validation/<date>-<host>-live.md` with the host version, OS, the command, the message id, and the time of each receipt stage seen (`queued`, `accepted`, `acknowledged`, reply). A synthetic test never makes a surface Verified.

Once `#720` merges, each receiver's record names this file, and the generated table shows Verified only when the file exists.

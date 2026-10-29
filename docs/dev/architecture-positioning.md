# Architecture Positioning: Multi-Agent Cockpit vs Agent Memory

This document clarifies Agent Board's role in the multi-agent software engineering stack and its relationship to persistent memory plugins (such as `claude-mem`).

---

## 1. Problem: Orthogonal Concerns in Agent Workflows

Developers managing autonomous coding agents frequently encounter two distinct challenges:
1. **Agent Amnesia (Micro Context Loss):** An agent working in a CLI session forgets decisions, debug discoveries, or architectural conventions once the session ends.
2. **Human Loss of Control (Macro Orchestration Blindness):** A developer running three or four agents in parallel (for example, Claude Code on design, Codex on migrations, Antigravity on testing) cannot see who is active, who is blocked on an approval, or where decisions conflict.

Tools addressing problem 1 (such as `claude-mem`) and tools addressing problem 2 (`agent-board`) share low-level mechanics—both use lifecycle hooks (`SessionStart`, `PreToolUse`, `Stop`) and manage persistent state. However, their primary actor, data flow, and architectural layer are orthogonal.

---

## 2. The Four-Layer Multi-Agent Stack

```
+-------------------------------------------------------------------+
|               Layer 4: Human Governance & Decisions               |
|                   Software Engineer / Architect                   |
+-------------------------------------------------------------------+
                                  ^
                                  | Approvals, reviews, status oversight
                                  v
+-------------------------------------------------------------------+
|            Layer 3: Mission Control Cockpit (Agent Board)         |
|   - Multi-agent aggregation (Claude, Codex, Antigravity, Cursor)   |
|   - Transparent single source of truth (progress.md / GFM ledger)  |
|   - Strict state machine (working, waiting, blocked, done)        |
|   - Bi-directional Human-in-the-Loop decision queues              |
+-------------------------------------------------------------------+
                                  |
                                  | Verified facts (progress-journal.md)
                                  v
+-------------------------------------------------------------------+
|        Layer 2: Internal Cognitive Memory (e.g. claude-mem)       |
|   - Context compression and distillation                          |
|   - Semantic indexing (SQLite FTS5 + Chroma vector store)         |
|   - Automated historical context injection                        |
+-------------------------------------------------------------------+
                                  ^
                                  | Context-aware prompt injection
                                  v
+-------------------------------------------------------------------+
|               Layer 1: Agent Execution Engines                    |
|        Claude Code, Antigravity, Codex, OpenCode, Cursor          |
+-------------------------------------------------------------------+
```

### Contrast Matrix

| Dimension | Persistent Memory (e.g. claude-mem) | Mission Control Cockpit (agent-board) |
| :--- | :--- | :--- |
| **Primary Consumer** | **AI Agent (Machine-to-Machine)** | **Human Developer (Human-to-Machine)** |
| **Mental Model** | Associative memory bank / hippocampus | Airplane cockpit heads-up display (HUD) |
| **Storage Engine** | SQLite (WAL) + Chroma vector database | Single human-readable Markdown (`progress.md`) |
| **Interaction** | Passive, automated injection | Active step ticking, Diff review, approval gates |
| **Scope** | Session-level recall within an agent | Multi-agent concurrency across diverse vendors |
| **Git Integration** | Binary database (gitignored) | Clean Markdown ledger (committed with code) |

---

## 3. Symbiotic Coexistence

Rather than competing, memory systems and mission control cockpits form a complementary pipeline:

1. **High-Purity Facts Upstream:**
   Raw tool observation transcripts often contain trial-and-error noise. In contrast, the steps recorded in Agent Board's ledger (`[x] Step`) represent human-authorized, verified milestones. Memory tools can ingest `progress-journal.md` as ground-truth facts to produce cleaner long-term memories.
2. **Surface Memory Status Downstream:**
   Memory tools operate in the dark background; developers often wonder whether context was successfully injected. Agent Board surfaces session health and readiness without cluttering the primary prompt window.

---

## 4. Engineering Insights: Hook Dispatcher Latency

A technical challenge in lifecycle hook integration is dispatch latency on Windows. Spawning interactive shell interpreters (`powershell.exe`) introduces cold-start latency (1.2s to 1.4s per invocation) due to CLR and profile loading.

Compiled native dispatchers (used by tools like `claude-mem` via lightweight native launcher binaries communicating over loopback IPC) demonstrate that offloading heavy processing to a background worker reduces hook latency to 5–15ms. Agent Board's v2.0 roadmap adopts this pattern by replacing nested shell invocations with a lightweight, persistent IPC launcher.

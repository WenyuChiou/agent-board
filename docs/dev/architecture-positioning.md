# Architecture Positioning: Multi-Agent Cockpit vs Agent Memory

This document clarifies Agent Board's role in the multi-agent software engineering stack and its relationship to memory tools.

---

## 1. Problem: Orthogonal Concerns in Agent Workflows

Developers managing autonomous coding agents frequently encounter two distinct challenges:
1. **Agent Amnesia (Micro Context Loss):** An agent working in a CLI session forgets decisions, debug discoveries, or architectural conventions once the session ends.
2. **Human Loss of Control (Macro Orchestration Blindness):** A developer running three or four agents in parallel (for example, Claude Code on design, Codex on migrations, Antigravity on testing) cannot see who is active, who is blocked on an approval, or where decisions conflict.

Tools addressing problem 1 (memory tools) and tools addressing problem 2 (`agent-board`) share low-level mechanics—both use lifecycle hooks (`SessionStart`, `PreToolUse`, `Stop`) and manage persistent state. However, their primary actor, data flow, and architectural layer are orthogonal.

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
|   - Multi-agent aggregation (Claude, Codex, Antigravity, Cursor)  |
|   - Transparent single source of truth (progress.md / GFM ledger) |
|   - Each session's state (working, waiting, done, ended), as      |
|     docs/FORMAT.md defines it                                     |
|   - Bi-directional Human-in-the-Loop decision queues              |
+-------------------------------------------------------------------+
                                  |
                                  | Progress milestones (progress-journal-YYYY-MM.md)
                                  v
+-------------------------------------------------------------------+
|               Layer 2: Internal Cognitive Memory                  |
|                          (Memory Tools)                           |
|   - Context compression and distillation                          |
|   - Semantic indexing (SQLite FTS5 + vector stores)               |
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

| Dimension | Memory Tools | Mission Control Cockpit (agent-board) |
| :--- | :--- | :--- |
| **Primary Consumer** | **AI Agent (Machine-to-Machine)** | **Human Developer (Human-to-Machine)** |
| **Mental Model** | Associative memory bank for the agent | Mission control cockpit for the developer |
| **Storage Engine** | SQLite (WAL) + vector database | One plain Markdown file (progress.md) |
| **Interaction** | Passive, automated injection | You read each agent's steps and answer its questions from the board |
| **Scope** | Session-level recall within an agent | Multi-agent concurrency across diverse vendors |
| **Git Integration** | Binary database (gitignored) | A plain Markdown file in the board's data folder, outside your repositories |

---

## 3. Symbiotic Coexistence

Rather than competing, memory systems and mission control cockpits form a complementary pipeline:

1. **Structured Milestones Upstream:**
   Raw tool observation transcripts often contain trial-and-error noise. In contrast, the steps recorded in Agent Board's ledger (`[x] Step`) represent structured task milestones reported by agents, which can be further confirmed or archived during human oversight. Memory tools can ingest monthly journal files following the `progress-journal-YYYY-MM.md` convention (e.g. `progress-journal-2026-10.md`) as structured progress records across months, providing clearer milestone history than unparsed terminal logs.
2. **Surface Memory Status Downstream:**
   Memory tools operate in the dark background; developers often wonder whether context was successfully injected. Agent Board surfaces session health and readiness without cluttering the primary prompt window.

---

## 4. Hook start-up time on Windows

Hook start-up time on Windows is tracked in #241 and #533.

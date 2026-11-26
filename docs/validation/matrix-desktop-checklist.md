# 0.26.0 Desktop-App Parity Checklist

Desktop-app cells stay out of `scripts/matrix-runner.mjs` and are run interactively by the PM/owner (`docs/dev/plan-0.26.0.md`, E6a).

- Record each run with **date, version/commit, install shape (`S` or `P`), result (`PASS` / `FAIL`), and evidence**.
- Keep screenshots **out of the repository** (attach in validation working notes or GitHub issues only).
- Check every cell on both install shapes:
  - **Shape `S`**: installed by `agent-board setup` (`~/.agent-board/`).
  - **Shape `P`**: wired by the Claude Code plugin connector (`~/.claude/agent-board/`).

## Surfaces & Checks

For each surface (`Claude desktop app`, `Codex app`, `Antigravity app`) on each shape (`S`, `P`):

| Surface | Shape | Check | Step & Expected Result |
|---|---|---|---|
| Claude desktop app | S / P | `a` Board opens | Open the board from inside the app session; page loads at `127.0.0.1` without leaking the one-use token in replies. |
| Claude desktop app | S / P | `b` One card | Trigger a question turn; Needs you shows **1** card matching the question (no duplicates). |
| Claude desktop app | S / P | `c` Reply goes in | Send a reply from the board card; reply reaches the session and the agent continues its turn with that answer. |
| Claude desktop app | S / P | `d` Timely status | Card shows accurate delivery status (`Sent` -> `Delivered` -> `Answered`, or `Unsure` past budget); also verify Hide, Confirm done, and Undo. |
| Codex app | S / P | `a` Board opens | Open the board from inside the Codex app thread; page loads cleanly. |
| Codex app | S / P | `b` One card | Trigger a question turn; Needs you shows **1** card (no split `[?]` + closing-line card). |
| Codex app | S / P | `c` Reply goes in | Send/reopen a reply from the board; answer reaches the thread and Codex continues with it. |
| Codex app | S / P | `d` Timely status | Status reflects delivery/wait/done accurately; finished task moves out of `waiting`/Stopped into Done. Verify Hide, Archive, Confirm done. |
| Antigravity app | S / P | `a` Board opens | Open the board from inside Antigravity app; page loads in configured language with single-use link protected. |
| Antigravity app | S / P | `b` One card | Ask a question turn (`[?]`); Needs you shows **1** card cleanly. |
| Antigravity app | S / P | `c` Reply goes in | Queue/send a reply from the board; next invocation/turn receives it (`ACK`) and continues with the answer. |
| Antigravity app | S / P | `d` Timely status | Ticking last step leaves `waiting`; Done row offers Archive & Confirm done; Hide & status transitions behave cleanly. |

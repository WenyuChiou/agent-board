- **Codex / reporting** · Withdrawing an agent-started Codex run no longer removes a block whose full session id contradicts its owner; the board file stays exactly as it was, as it does for an explicit report (#682).
  Tests: `run withdrawal refuses a block whose native resume contradicts its owner and keeps every byte`.

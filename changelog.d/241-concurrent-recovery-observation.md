### Fixed

- **Concurrent hook acceptance observes bounded recovery (#241).** The twelve-writer check retains its foreground-exit diagnostics and verifies every block after pending events settle. A controlled busy write proves that recovery preserves the queued event and its source timestamps without another prompt.
  Tests: `writers taking the native lock: 8 Codex hooks and 4 FORMAT.md writers lose no block on Windows`, `concurrent writers wait for autonomous recovery before asserting every block exactly once`.

### Fixed

- **Configurable session inactivity staleness prevents 12-hour zombie stall (#532).** Pure staleness helpers support custom timeouts with lower bound validation, allowing environments to detect crashed or terminated sessions without waiting half a day. The board CLI passes `--stale-ms` and `AGENT_BOARD_STALE_MS` while preserving the 12-hour default for existing workflows.
  Tests: `parseStaleMs supports custom values, clamps to 1 minute, and falls back to default`, `isStale respects configurable staleness threshold`.

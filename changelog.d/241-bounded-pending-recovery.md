- **Queued lifecycle events recover without another prompt (#241).** The native hook
  worker coalesces one bounded metadata recovery job per selected board, preserves
  source event times and leaves persistent failures available to `--recover-hooks`.
  Recovery does not send or replay messages, invoke models or change hook trust.
  Tests: `automatic hook recovery applies a queued Antigravity Stop after the lock is released`,
  `automatic hook recovery exhausts three locked attempts and leaves manual recovery possible`,
  `automatic hook recovery serializes competing stale replacement candidates`,
  `manual hook recovery drains a queued final Stop without waiting for stdin`,
  `manual hook recovery drops stale metadata and leaves other boards and messages untouched`.

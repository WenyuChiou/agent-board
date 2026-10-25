- L2 working-day batches use explicit ordered update times, so rapid same-millisecond writes cannot make the latest-agent check depend on a recency tie (#434).
  Tests: `L2 day: work finished by Codex, Antigravity and Hermes counts in done today on every surface`, `L2 day: a block reaching done writes one journal line for any agent`.

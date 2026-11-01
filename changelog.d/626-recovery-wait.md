- **Tests / Windows recovery evidence** · A concurrent-writer recovery failure includes helper, lock and pending-event timestamps in its assertion message, while successful runs stay quiet. The 10-second recovery limit and all block checks stay in place (#626).
  Tests: `concurrent writers wait for autonomous recovery before asserting every block exactly once`.
